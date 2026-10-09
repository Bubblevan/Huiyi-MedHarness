import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HealthCaseState } from '../case/contracts.js'
import type {
  CaseComplexity,
  CollaborationPlan,
  CollaborationProfile,
  CollaborationSnapshot,
  SpecialistFinding,
  SpecialistSpec,
  TeamFinding,
} from './contracts.js'
import { CollaborationBudget } from './budget.js'
import { decodeComplexityDecision, decodeSpecialistFinding, decodeTeamFindingSummary, emptyCollaborationPlan, planFromMdt, planFromRecruitment } from './planner.js'
import { policyFor } from './policy.js'
import {
  buildComplexityClassificationPrompt,
  buildMdtPlanningPrompt,
  buildPeerRefinementPrompt,
  buildSpecialistAnalysisPrompt,
  buildSpecialistFinalPrompt,
  buildSpecialistRecruitmentPrompt,
  buildTeamSynthesisPrompt,
} from './prompts.js'
import { buildModeratorRequest } from './moderator.js'
import { complexityDecisionSchema, mdtPlanningSchema, recruitmentPlanSchema, specialistFindingSchema, teamSynthesisSchema } from './schemas.js'
import type { ClinicalChildRequest, ClinicalChildResult, ClinicalChildRunner } from './runner.js'
import { hashCaseQuery, MetadataCollaborationTrace, safeFailureClass } from './trace.js'
import type { CollaborationTraceSink } from './trace.js'

export interface CollaborateInput {
  readonly parentAgent: Agent
  readonly caseState: HealthCaseState
  readonly profile: CollaborationProfile
  readonly signal: AbortSignal
}

export class CollaborationOrchestrator {
  constructor(
    private readonly runner: ClinicalChildRunner,
    private readonly trace: CollaborationTraceSink = new MetadataCollaborationTrace(),
  ) {}

  async collaborate(input: CollaborateInput): Promise<CollaborationSnapshot> {
    const { parentAgent, caseState, profile, signal } = input
    const policy = policyFor(profile)
    const budget = new CollaborationBudget(policy)
    const caseHash = hashCaseQuery(caseState.query)
    let complexity: CaseComplexity = 'basic'
    let degraded = signal.aborted
    let plan: CollaborationPlan = emptyCollaborationPlan(complexity)
    let specialistFindings: SpecialistFinding[] = []
    let teamFindings: TeamFinding[] = []
    let advancedTeamsViable = false
    let moderator: CollaborationSnapshot['moderator']

    const recordSkipped = (request: ClinicalChildRequest, reason: 'Aborted' | 'BudgetExhausted'): void => {
      const time = Date.now()
      this.trace.record({
        event: 'policy', caseHash, profile, complexity, task: request.kind, roleLabel: request.roleLabel,
        startedAt: time, endedAt: time, durationMs: 0, status: 'skipped',
        ...(request.round === undefined ? {} : { round: request.round }),
        childRunCount: budget.snapshot().startedChildRuns, degraded: true, failureClass: reason,
      })
    }

    const runChild = async (request: ClinicalChildRequest): Promise<ClinicalChildResult | undefined> => {
      if (signal.aborted) {
        degraded = true
        recordSkipped(request, 'Aborted')
        return undefined
      }
      if (!budget.startChildRun()) {
        degraded = true
        recordSkipped(request, 'BudgetExhausted')
        return undefined
      }

      let result: ClinicalChildResult
      try {
        result = await this.runner.run(parentAgent, request, signal)
      } catch (error: unknown) {
        const time = Date.now()
        result = {
          status: 'failed', failureClass: safeFailureClass(error), startedAt: time, endedAt: time,
          ...(signal.aborted ? { stopReason: 'aborted' } : {}),
        }
      }
      if (result.status === 'completed') budget.completeChildRun()
      else {
        budget.failChildRun()
        degraded = true
      }
      this.trace.record({
        event: 'child', caseHash, profile, complexity, task: request.kind, roleLabel: request.roleLabel,
        ...(result.runId ? { childRunId: result.runId } : {}),
        startedAt: result.startedAt, endedAt: result.endedAt, durationMs: Math.max(0, result.endedAt - result.startedAt),
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        status: result.status,
        ...(request.round === undefined ? {} : { round: request.round }),
        childRunCount: budget.snapshot().startedChildRuns, degraded,
        ...(result.status === 'failed' ? { failureClass: safeFailureClass(result.failureClass) } : {}),
      })
      return result
    }

    const classifierRequest: ClinicalChildRequest = {
      kind: 'complexity-classifier', label: 'clinical-complexity-classifier', roleLabel: 'classifier',
      prompt: buildComplexityClassificationPrompt(caseState),
      persona: 'You classify only the collaboration execution complexity. Return one schema-valid decision and a concise rationale summary.',
      outputSchema: complexityDecisionSchema,
      decode: decodeComplexityDecision,
    }

    if (!signal.aborted) {
      const classification = await runChild(classifierRequest)
      if (classification?.status === 'completed') {
        complexity = (classification.value as { complexity: CaseComplexity }).complexity
        plan = emptyCollaborationPlan(complexity)
      } else {
        degraded = true
      }
    }

    if (complexity === 'intermediate' && !signal.aborted) {
      const recruitmentRequest: ClinicalChildRequest = {
        kind: 'specialist-recruiter', label: 'clinical-specialist-recruiter', roleLabel: 'specialist recruiter',
        prompt: buildSpecialistRecruitmentPrompt(caseState, policy.recruitmentTarget),
        persona: 'You recruit distinct medical specialties for an independent structured review. Return role and expertise only.',
        outputSchema: recruitmentPlanSchema,
        decode: value => planFromRecruitment('intermediate', value, policy),
      }
      const recruitment = await runChild(recruitmentRequest)
      if (recruitment?.status === 'completed') plan = recruitment.value as CollaborationPlan
      else degraded = true
    } else if (complexity === 'advanced' && !signal.aborted) {
      const mdtRequest: ClinicalChildRequest = {
        kind: 'mdt-planner', label: 'clinical-mdt-planner', roleLabel: 'MDT planner',
        prompt: buildMdtPlanningPrompt(caseState, policy.maxTeams, policy.maxSpecialists),
        persona: 'You organize bounded multidisciplinary teams with explicit goals, member expertise, and at most one lead per team.',
        outputSchema: mdtPlanningSchema,
        decode: value => planFromMdt(value, policy),
      }
      const mdtPlan = await runChild(mdtRequest)
      if (mdtPlan?.status === 'completed') plan = mdtPlan.value as CollaborationPlan
      else degraded = true
    }

    budget.setPlanCounts(plan.specialists.length, plan.teams.length)

    if (complexity === 'intermediate' && plan.specialists.length > 0 && !signal.aborted) {
      const findingsById = new Map<string, SpecialistFinding>()
      const roundOneStarted = budget.snapshot().startedChildRuns
      const firstPass = await mapBounded(plan.specialists, policy.maxConcurrency, signal, async specialist => {
        const request = specialistRequest(caseState, specialist, 0)
        return { specialist, result: await runChild(request) }
      })
      for (const item of firstPass) {
        if (item?.result?.status === 'completed') findingsById.set(item.specialist.id, item.result.value as SpecialistFinding)
      }
      const firstPassStarted = budget.snapshot().startedChildRuns - roundOneStarted
      if (!signal.aborted && firstPassStarted === plan.specialists.length && findingsById.size === plan.specialists.length) budget.completeRound()
      else degraded = true

      if (findingsById.size === 0) degraded = true
      const totalRounds = policy.maxRounds
      if (policy.peerRefinementEnabled && totalRounds > 0 && findingsById.size > 0) {
        for (let round = 1; round <= totalRounds && !signal.aborted; round += 1) {
          let wholeRoundSettled = true
          for (let turn = 1; turn <= policy.maxTurnsPerRound && !signal.aborted; turn += 1) {
            const currentFindings = [...findingsById.values()]
            const participants = plan.specialists.filter(specialist => findingsById.has(specialist.id))
            const turnStarted = budget.snapshot().startedChildRuns
            const refined = await mapBounded(participants, policy.maxConcurrency, signal, async specialist => {
              const ownFinding = findingsById.get(specialist.id)
              if (!ownFinding) return undefined
              const request: ClinicalChildRequest = {
                kind: 'peer-refinement',
                label: `clinical-peer-refinement-${specialist.id}-r${round}-t${turn}`,
                roleLabel: specialist.role,
                prompt: buildPeerRefinementPrompt(caseState, specialist, ownFinding, currentFindings),
                persona: `You refine the assessment of ${specialist.role} using only the assigned case and bounded peer summaries.`,
                outputSchema: specialistFindingSchema,
                decode: value => decodeSpecialistFinding(value, specialist),
                round,
              }
              return { specialist, result: await runChild(request) }
            })
            for (const item of refined) {
              if (item?.result?.status === 'completed') findingsById.set(item.specialist.id, item.result.value as SpecialistFinding)
            }
            const turnStartedCount = budget.snapshot().startedChildRuns - turnStarted
            if (turnStartedCount !== participants.length || refined.some(item => item?.result?.status !== 'completed')) {
              wholeRoundSettled = false
            }
            if (turnStartedCount < participants.length) break
          }
          if (wholeRoundSettled && !signal.aborted) budget.completeRound()
          else degraded = true
        }

        const finalParticipants = plan.specialists.filter(specialist => findingsById.has(specialist.id))
        if (finalParticipants.length > 0 && !signal.aborted) {
          const finalResults = await mapBounded(finalParticipants, policy.maxConcurrency, signal, async specialist => {
            const ownFinding = findingsById.get(specialist.id)
            if (!ownFinding) return undefined
            const request: ClinicalChildRequest = {
              kind: 'specialist-final',
              label: `clinical-specialist-final-${specialist.id}`,
              roleLabel: specialist.role,
              prompt: buildSpecialistFinalPrompt(caseState, specialist, ownFinding, [...findingsById.values()]),
              persona: `You submit the final structured assessment for your assigned role after bounded peer collaboration. Do not include hidden reasoning.`,
              outputSchema: specialistFindingSchema,
              decode: value => decodeSpecialistFinding(value, specialist),
              round: totalRounds + 1,
            }
            return { specialist, result: await runChild(request) }
          })
          for (const item of finalResults) {
            if (item?.result?.status === 'completed') findingsById.set(item.specialist.id, item.result.value as SpecialistFinding)
          }
          if (finalResults.some(item => item?.result?.status !== 'completed')) degraded = true
        }
      }
      specialistFindings = [...findingsById.values()]
    } else if (complexity === 'advanced' && plan.teams.length > 0 && !signal.aborted) {
      const specialistStarted = budget.snapshot().startedChildRuns
      const specialistResults = await mapBounded(plan.specialists, policy.maxConcurrency, signal, async specialist => {
        return { specialist, result: await runChild(specialistRequest(caseState, specialist, 1)) }
      })
      const findingsById = new Map<string, SpecialistFinding>()
      for (const item of specialistResults) {
        if (item?.result?.status === 'completed') findingsById.set(item.specialist.id, item.result.value as SpecialistFinding)
      }
      specialistFindings = [...findingsById.values()]
      const started = budget.snapshot().startedChildRuns - specialistStarted
      if (!signal.aborted && started === plan.specialists.length && findingsById.size === plan.specialists.length) budget.completeRound()
      else degraded = true

      advancedTeamsViable = plan.teams.length > 0 && plan.teams.every(team => team.members.some(member => findingsById.has(member.id)))
      if (!advancedTeamsViable) degraded = true
      if (advancedTeamsViable && !signal.aborted) {
        const synthesisResults = await mapBounded(plan.teams, policy.maxConcurrency, signal, async team => {
          const memberFindings = team.members.flatMap(member => {
            const finding = findingsById.get(member.id)
            return finding ? [finding] : []
          })
          const request: ClinicalChildRequest = {
            kind: 'team-synthesis', label: `clinical-team-synthesis-${team.id}`, roleLabel: 'team synthesis', teamId: team.id,
            prompt: buildTeamSynthesisPrompt(caseState, team, memberFindings),
            persona: `You synthesize structured findings for team goal: ${team.goal}`,
            outputSchema: teamSynthesisSchema,
            decode: value => decodeTeamFindingSummary(value, team, memberFindings),
          }
          return await runChild(request)
        })
        teamFindings = synthesisResults.flatMap(result =>
          result?.status === 'completed' ? [result.value as TeamFinding] : [],
        )
        if (teamFindings.length !== plan.teams.length) degraded = true
      }
    }

    const moderatorEligible = complexity === 'intermediate'
      ? specialistFindings.length > 0
      : complexity === 'advanced' && advancedTeamsViable && specialistFindings.length > 0
    if (moderatorEligible && !signal.aborted) {
      const moderatorRequest = buildModeratorRequest(caseState, specialistFindings, teamFindings)
      const decision = await runChild(moderatorRequest)
      if (decision?.status === 'completed') moderator = decision.value as CollaborationSnapshot['moderator']
      else degraded = true
    }

    if (signal.aborted) degraded = true
    const counts = budget.snapshot()
    return {
      complexity,
      plan,
      specialistFindings,
      teamFindings,
      ...(moderator ? { moderator } : {}),
      execution: {
        childRuns: counts.startedChildRuns,
        failedChildRuns: counts.failedChildRuns,
        completedRounds: counts.completedRounds,
        degraded,
      },
    }
  }
}

function specialistRequest(
  caseState: HealthCaseState,
  specialist: SpecialistSpec,
  round: number,
): ClinicalChildRequest {
  return {
    kind: 'specialist-analysis',
    label: `clinical-specialist-${specialist.id}`,
    roleLabel: specialist.role,
    prompt: buildSpecialistAnalysisPrompt(caseState, specialist),
    persona: `You are a cautious medical specialist assigned as ${specialist.role}. Return a concise structured finding, not hidden reasoning.`,
    outputSchema: specialistFindingSchema,
    decode: value => decodeSpecialistFinding(value, specialist),
    round,
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length)
  let cursor = 0
  const workerCount = Math.min(items.length, Math.max(1, concurrency))
  const workers = Array.from({ length: workerCount }, async () => {
    while (!signal.aborted) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
