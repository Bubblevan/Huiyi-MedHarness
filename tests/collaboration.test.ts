import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HealthCaseState } from '../src/case/contracts.js'
import { CollaborationBudget } from '../src/collaboration/budget.js'
import type { ClinicalChildRequest, ClinicalChildResult, ClinicalChildRunner, ClinicalStopReason } from '../src/collaboration/runner.js'
import { CollaborationOrchestrator } from '../src/collaboration/orchestrator.js'
import { benchmarkPolicy, policyFor, productPolicy } from '../src/collaboration/policy.js'
import { planFromMdt, planFromRecruitment } from '../src/collaboration/planner.js'
import { MetadataCollaborationTrace } from '../src/collaboration/trace.js'

const parent = {} as Agent

function caseState(query = 'synthetic collaboration case'): HealthCaseState {
  return { query }
}

type FakeReply = {
  readonly stopReason?: ClinicalStopReason
  readonly structured?: unknown
}

type FakeHandler = (request: ClinicalChildRequest, signal: AbortSignal, index: number) => FakeReply | Promise<FakeReply>

/** Test-only fake; production source has no simulated child runtime. */
class FakeClinicalChildRunner implements ClinicalChildRunner {
  readonly requests: ClinicalChildRequest[] = []
  activeRuns = 0
  maxActiveRuns = 0

  constructor(private readonly handler: FakeHandler = defaultReply) {}

  async run(_parent: Agent, request: ClinicalChildRequest, signal: AbortSignal): Promise<ClinicalChildResult> {
    const startedAt = Date.now()
    const index = this.requests.length
    this.requests.push(request)
    if (signal.aborted) {
      return { status: 'failed', failureClass: 'Aborted', stopReason: 'aborted', startedAt, endedAt: Date.now() }
    }
    this.activeRuns += 1
    this.maxActiveRuns = Math.max(this.maxActiveRuns, this.activeRuns)
    try {
      const reply = await this.handler(request, signal, index)
      const stopReason = reply.stopReason ?? 'completed'
      const endedAt = Date.now()
      if (stopReason !== 'completed') {
        return { status: 'failed', failureClass: 'ChildNotCompleted', stopReason, startedAt, endedAt, runId: `fake-${index + 1}` }
      }
      if (reply.structured === undefined) {
        return { status: 'failed', failureClass: 'MissingStructuredOutput', stopReason, startedAt, endedAt, runId: `fake-${index + 1}` }
      }
      try {
        return {
          status: 'completed', value: request.decode(reply.structured), stopReason: 'completed',
          startedAt, endedAt, runId: `fake-${index + 1}`,
        }
      } catch {
        return { status: 'failed', failureClass: 'InvalidStructuredOutput', stopReason: 'completed', startedAt, endedAt, runId: `fake-${index + 1}` }
      }
    } finally {
      this.activeRuns -= 1
    }
  }
}

function specialists(count = 3): Array<{ role: string; expertise: string }> {
  return Array.from({ length: count }, (_, index) => ({ role: `Specialty ${index + 1}`, expertise: `Expertise ${index + 1}` }))
}

function defaultReply(request: ClinicalChildRequest): FakeReply {
  switch (request.kind) {
    case 'complexity-classifier':
      return { structured: { complexity: 'intermediate', rationaleSummary: 'Synthetic test routing.' } }
    case 'specialist-recruiter':
      return { structured: { specialists: specialists(3) } }
    case 'mdt-planner':
      return { structured: { teams: [] } }
    case 'specialist-analysis': {
      const id = request.label.replace('clinical-specialist-', '')
      return { structured: { specialistId: id, role: request.roleLabel, summary: `Synthetic summary for ${id}.`, recommendation: `Recommendation for ${id}.`, confidence: 0.8 } }
    }
    case 'peer-refinement': {
      const match = /clinical-peer-refinement-(.+)-r\d+-t\d+/.exec(request.label)
      return { structured: { specialistId: match?.[1] ?? '', role: request.roleLabel, summary: 'Refined synthetic summary.' } }
    }
    case 'specialist-final': {
      const id = request.label.replace('clinical-specialist-final-', '')
      return { structured: { specialistId: id, role: request.roleLabel, summary: `Final synthetic summary for ${id}.` } }
    }
    case 'team-synthesis':
      return { structured: { teamId: request.teamId, summary: 'Synthetic team summary.' } }
    case 'moderator':
      return { structured: { summary: 'Synthetic moderator summary.', agreement: 'Synthetic agreement.', disagreements: [], recommendedAnswer: 'Synthetic recommendation.' } }
  }
}

async function runProduct(runner: FakeClinicalChildRunner, state = caseState(), signal = new AbortController().signal) {
  return new CollaborationOrchestrator(runner).collaborate({ parentAgent: parent, caseState: state, profile: 'product', signal })
}

describe('collaboration planner and policy', () => {
  it('keeps basic cases on the root single-agent path', async () => {
    const runner = new FakeClinicalChildRunner(request => request.kind === 'complexity-classifier'
      ? { structured: { complexity: 'basic', rationaleSummary: 'Single-agent route.' } }
      : defaultReply(request))
    const snapshot = await runProduct(runner)
    expect(snapshot).toMatchObject({ complexity: 'basic', plan: { specialists: [], teams: [] }, specialistFindings: [], teamFindings: [] })
    expect(snapshot.moderator).toBeUndefined()
    expect(runner.requests.map(request => request.kind)).toEqual(['complexity-classifier'])
    expect(snapshot.execution.childRuns).toBe(1)
  })

  it('retains five benchmark recruits and caps product recruitment at its configured limit', () => {
    const candidate = { specialists: specialists(5) }
    const benchmark = planFromRecruitment('intermediate', candidate, benchmarkPolicy)
    const product = planFromRecruitment('intermediate', candidate, productPolicy)
    expect(benchmark.specialists).toHaveLength(5)
    expect(product.specialists).toHaveLength(productPolicy.maxSpecialists)
    expect(policyFor('benchmark')).toMatchObject({ maxRounds: 5, maxTurnsPerRound: 5, recruitmentTarget: 5, maxChildRuns: 138 })
    expect(policyFor('product')).toMatchObject({ maxSpecialists: 3, maxTeams: 2, maxRounds: 1, maxChildRuns: 16 })
  })

  it('covers the full encoded benchmark intermediate call ceiling', async () => {
    const runner = new FakeClinicalChildRunner(request => request.kind === 'specialist-recruiter'
      ? { structured: { specialists: specialists(5) } }
      : defaultReply(request))
    const snapshot = await new CollaborationOrchestrator(runner).collaborate({
      parentAgent: parent,
      caseState: caseState(),
      profile: 'benchmark',
      signal: new AbortController().signal,
    })
    expect(runner.requests.filter(request => request.kind === 'specialist-analysis')).toHaveLength(5)
    expect(runner.requests.filter(request => request.kind === 'peer-refinement')).toHaveLength(125)
    expect(runner.requests.filter(request => request.kind === 'specialist-final')).toHaveLength(5)
    expect(runner.requests.filter(request => request.kind === 'moderator')).toHaveLength(1)
    expect(snapshot.execution).toMatchObject({ childRuns: 138, failedChildRuns: 0, completedRounds: 6, degraded: false })
    expect(runner.maxActiveRuns).toBeLessThanOrEqual(benchmarkPolicy.maxConcurrency)
  })

  it('runs independent product specialists in bounded parallel work and moderates all findings', async () => {
    const runner = new FakeClinicalChildRunner()
    const snapshot = await runProduct(runner)
    const specialistRuns = runner.requests.filter(request => request.kind === 'specialist-analysis')
    const moderator = runner.requests.find(request => request.kind === 'moderator')
    expect(specialistRuns).toHaveLength(3)
    expect(snapshot.specialistFindings).toHaveLength(3)
    expect(moderator?.prompt).toContain('Specialist Summaries')
    expect(snapshot.moderator?.summary).toBe('Synthetic moderator summary.')
    expect(snapshot.execution.degraded).toBe(false)
    expect(snapshot.execution.completedRounds).toBe(1)
    expect(runner.maxActiveRuns).toBeLessThanOrEqual(productPolicy.maxConcurrency)
    expect(specialistRuns[0].prompt).toContain('Patient Memory Snapshot')
    expect(specialistRuns[0].prompt).toContain('External Evidence Snapshot')
  })

  it('continues to moderator with two completed specialists when one specialist errors', async () => {
    const runner = new FakeClinicalChildRunner(request => {
      if (request.kind === 'specialist-analysis' && request.roleLabel === 'Specialty 2') return { stopReason: 'error', structured: { partial: 'ignored' } }
      return defaultReply(request)
    })
    const snapshot = await runProduct(runner)
    expect(snapshot.specialistFindings).toHaveLength(2)
    expect(runner.requests.some(request => request.kind === 'moderator')).toBe(true)
    expect(snapshot.execution).toMatchObject({ failedChildRuns: 1, degraded: true })
  })

  it('rejects max-tokens partial specialist output and never parses it into a finding', async () => {
    const runner = new FakeClinicalChildRunner(request => {
      if (request.kind === 'specialist-analysis' && request.roleLabel === 'Specialty 1') {
        const id = request.label.replace('clinical-specialist-', '')
        return { stopReason: 'max-tokens', structured: { specialistId: id, role: request.roleLabel, summary: 'Must be discarded.' } }
      }
      return defaultReply(request)
    })
    const snapshot = await runProduct(runner)
    expect(snapshot.specialistFindings).toHaveLength(2)
    expect(snapshot.specialistFindings.some(finding => finding.summary === 'Must be discarded.')).toBe(false)
    expect(snapshot.execution.failedChildRuns).toBe(1)
  })

  it('keeps specialist findings when moderator output fails and fabricates no decision', async () => {
    const runner = new FakeClinicalChildRunner(request => request.kind === 'moderator'
      ? { stopReason: 'error', structured: { summary: 'partial' } }
      : defaultReply(request))
    const snapshot = await runProduct(runner)
    expect(snapshot.specialistFindings).toHaveLength(3)
    expect(snapshot.moderator).toBeUndefined()
    expect(snapshot.execution).toMatchObject({ failedChildRuns: 1, degraded: true })
  })

  it('normalizes adversarial recruitment, rejects invalid roles, deduplicates, and caps execution', async () => {
    const adversarial = [
      { role: ' Cardiology ', expertise: ' Heart assessment ' },
      { role: 'cardiology', expertise: 'Duplicate role.' },
      { role: '', expertise: 'Empty role.' },
      { role: 'X'.repeat(81), expertise: 'Overlong role.' },
      { role: 'Endocrinology', expertise: 'Hormone assessment.' },
      { role: 'Nephrology', expertise: 'Kidney assessment.' },
      ...specialists(100),
    ]
    const runner = new FakeClinicalChildRunner(request => request.kind === 'specialist-recruiter'
      ? { structured: { specialists: adversarial } }
      : request.kind === 'complexity-classifier'
        ? { structured: { complexity: 'intermediate', rationaleSummary: 'Synthetic test routing.' } }
        : defaultReply(request))
    const snapshot = await runProduct(runner)
    const recruited = snapshot.plan.specialists
    expect(recruited).toHaveLength(3)
    expect(recruited.map(item => item.role)).toEqual(['Cardiology', 'Endocrinology', 'Nephrology'])
    expect(runner.requests.filter(request => request.kind === 'specialist-analysis')).toHaveLength(3)
    expect(snapshot.execution.childRuns).toBeLessThanOrEqual(productPolicy.maxChildRuns)
  })

  it('encodes the advanced benchmark plan as three teams of three without running children', () => {
    const input = {
      teams: Array.from({ length: 3 }, (_, teamIndex) => ({
        goal: `Team ${teamIndex + 1} goal`,
        members: specialists(3).map((member, index) => ({ ...member, lead: index === 0 })),
      })),
    }
    const plan = planFromMdt(input, benchmarkPolicy)
    expect(plan.teams).toHaveLength(3)
    expect(plan.teams.map(team => team.members)).toHaveLength(3)
    expect(plan.teams.every(team => team.members.length === 3 && team.leadSpecialistId)).toBe(true)
    expect(plan.specialists).toHaveLength(9)
  })

  it('skips team synthesis and moderator when every specialist in one advanced team fails', async () => {
    const runner = new FakeClinicalChildRunner(request => {
      if (request.kind === 'complexity-classifier') {
        return { structured: { complexity: 'advanced', rationaleSummary: 'Synthetic MDT route.' } }
      }
      if (request.kind === 'mdt-planner') {
        return {
          structured: {
            teams: [
              { goal: 'First synthetic team', members: [
                { role: 'Cardiology', expertise: 'Heart assessment', lead: true },
                { role: 'Emergency medicine', expertise: 'Acute assessment' },
                { role: 'Neurology', expertise: 'Neurologic assessment' },
              ] },
              { goal: 'Second synthetic team', members: [
                { role: 'Endocrinology', expertise: 'Endocrine assessment', lead: true },
                { role: 'Nephrology', expertise: 'Renal assessment' },
                { role: 'Internal medicine', expertise: 'Broad medical assessment' },
              ] },
            ],
          },
        }
      }
      if (request.kind === 'specialist-analysis' && request.label.includes('team-2-specialist')) {
        return { stopReason: 'error', structured: { partial: 'discarded' } }
      }
      return defaultReply(request)
    })
    const snapshot = await runProduct(runner)
    expect(snapshot.plan.teams).toHaveLength(2)
    expect(snapshot.specialistFindings).toHaveLength(2)
    expect(runner.requests.filter(request => request.kind === 'team-synthesis')).toHaveLength(0)
    expect(runner.requests.some(request => request.kind === 'moderator')).toBe(false)
    expect(snapshot.moderator).toBeUndefined()
    expect(snapshot.execution).toMatchObject({ failedChildRuns: 1, degraded: true })
  })

  it('enforces a child-run budget before admitting another start', () => {
    const budget = new CollaborationBudget({ ...productPolicy, maxChildRuns: 2 })
    expect(budget.startChildRun()).toBe(true)
    budget.completeChildRun()
    expect(budget.startChildRun()).toBe(true)
    budget.failChildRun()
    expect(budget.startChildRun()).toBe(false)
    expect(budget.snapshot()).toMatchObject({ startedChildRuns: 2, completedChildRuns: 1, failedChildRuns: 1 })
  })
})

describe('collaboration cancellation and metadata trace', () => {
  it('cancels before the first run without starting children', async () => {
    const controller = new AbortController()
    controller.abort()
    const runner = new FakeClinicalChildRunner()
    const snapshot = await runProduct(runner, caseState(), controller.signal)
    expect(runner.requests).toHaveLength(0)
    expect(snapshot.execution).toMatchObject({ childRuns: 0, degraded: true })
  })

  it('propagates cancellation during parallel specialists, settles active work, and skips moderator', async () => {
    const controller = new AbortController()
    let abortScheduled = false
    const runner = new FakeClinicalChildRunner(async (request, signal) => {
      if (request.kind === 'specialist-analysis') {
        if (!abortScheduled) {
          abortScheduled = true
          setTimeout(() => controller.abort(), 0)
        }
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { stopReason: 'aborted', structured: { partial: true } }
      }
      return defaultReply(request)
    })
    const snapshot = await runProduct(runner, caseState(), controller.signal)
    expect(runner.requests.filter(request => request.kind === 'specialist-analysis')).toHaveLength(3)
    expect(runner.requests.some(request => request.kind === 'moderator')).toBe(false)
    expect(runner.activeRuns).toBe(0)
    expect(snapshot.execution).toMatchObject({ failedChildRuns: 3, degraded: true })
  })

  it('cancels after specialists and before moderator without creating that child', async () => {
    const controller = new AbortController()
    let specialistCount = 0
    const runner = new FakeClinicalChildRunner(request => {
      if (request.kind === 'specialist-analysis') {
        specialistCount += 1
        if (specialistCount === 3) controller.abort()
      }
      return defaultReply(request)
    })
    const snapshot = await runProduct(runner, caseState(), controller.signal)
    expect(snapshot.specialistFindings).toHaveLength(3)
    expect(runner.requests.some(request => request.kind === 'moderator')).toBe(false)
    expect(runner.activeRuns).toBe(0)
    expect(snapshot.execution.degraded).toBe(true)
  })

  it('records only metadata and hashes case text', async () => {
    const trace = new MetadataCollaborationTrace()
    const runner = new FakeClinicalChildRunner()
    const state = caseState('PRIVATE_CASE_TEXT')
    const snapshot = await new CollaborationOrchestrator(runner, trace).collaborate({
      parentAgent: parent, caseState: state, profile: 'product', signal: new AbortController().signal,
    })
    const serializedTrace = JSON.stringify(trace.records)
    expect(trace.records.length).toBeGreaterThan(0)
    expect(trace.records[0]).toMatchObject({ event: 'child', task: 'complexity-classifier', profile: 'product' })
    expect(trace.records.every(record => record.caseHash.length === 64)).toBe(true)
    expect(serializedTrace).not.toContain('PRIVATE_CASE_TEXT')
    expect(serializedTrace).not.toContain('Synthetic summary')
    expect(JSON.stringify(snapshot)).toContain('Synthetic summary')
  })
})
