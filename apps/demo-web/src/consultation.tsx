import { useMemo, type ComponentProps } from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ErrorNotice, useEvidenceAction } from "./components.js";
import { createDemoAdapter, type Scenario, type WireDemoEvent } from "./runtime/adapter.js";
import { isNonDemoBuild } from "./config/env.js";
import { clinicalCopy } from "@clinical-workstation-copy";

const API_BASE = import.meta.env.HUIYI_DEMO_API_BASE || "/api";

const CitationAnchor = ({ href, children, ...props }: ComponentProps<"a">) => {
  const onOpen = useEvidenceAction();
  if (href?.startsWith("#evidence:")) {
    const evidenceId = href.slice("#evidence:".length);
    return <button type="button" className="citation-link" onClick={() => onOpen(evidenceId)} aria-label={`查看证据 ${evidenceId}`}>{children}</button>;
  }
  return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
};

function CitationMarkdown() { return <MarkdownTextPrimitive components={{ a: CitationAnchor }} />; }

function QuickPrompts({ enabled }: { enabled: boolean }) {
  const aui = useAui();
  return <div className="quick-prompts"><button disabled={!enabled} onClick={() => void aui.composer.setText(clinicalCopy.quickPromptVisit)}>整理复诊问题 <span>↗</span></button><button disabled={!enabled} onClick={() => void aui.composer.setText(clinicalCopy.quickPromptNextSteps)}>生成沟通清单 <span>↗</span></button></div>;
}

export function Consultation({ patientId, encounterId, sessionId, scenario, canSubmit, onEvent, onError, onRetry, onChooseScenario, includeScenario = true, showInternalMetadata = true, errorCode }: {
  patientId: string; encounterId?: string; sessionId: string; scenario: Scenario; canSubmit: boolean;
  includeScenario?: boolean;
  showInternalMetadata?: boolean;
  onEvent: (event: WireDemoEvent) => void; onError: (code: string) => void; onRetry: () => void; onChooseScenario: (scenario: Scenario) => void; errorCode?: string;
}) {
  const adapter = useMemo<ChatModelAdapter>(() => createDemoAdapter({ patientId, encounterId, sessionId, scenario, includeScenario, onEvent, onError, apiBase: API_BASE }), [patientId, encounterId, sessionId, scenario, includeScenario, onEvent, onError]);
  const runtime = useLocalRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>
    <section className="consultation" aria-label={clinicalCopy.consultationTitle}>
      <header className="consultation-header">
        <div><p className="eyebrow">{clinicalCopy.consultationLabel}</p><h1>{clinicalCopy.consultationTitle}</h1></div>
        {showInternalMetadata && <div className="session-meta"><span><i /> Encounter</span><span>Session <code>{sessionId.slice(0, 8)}</code></span></div>}
      </header>
      {!isNonDemoBuild && <div className="scenario-strip" aria-label={clinicalCopy.scenarioAriaLabel}>
        <div><span className="scenario-label">{clinicalCopy.scenarioLabel}</span><span>{clinicalCopy.scenarioInstruction}</span></div>
        <div className="scenario-actions"><button aria-pressed={scenario === "simple"} className={scenario === "simple" ? "scenario-button selected" : "scenario-button"} onClick={() => onChooseScenario("simple")}>{clinicalCopy.simpleScenario}</button><button aria-pressed={scenario === "complex"} className={scenario === "complex" ? "scenario-button selected" : "scenario-button"} onClick={() => onChooseScenario("complex")}>{clinicalCopy.complexScenario}</button></div>
      </div>}
      {errorCode && <div className="consultation-error"><ErrorNotice message={`执行状态：${errorCode}`} onRetry={onRetry} /></div>}
      <ThreadPrimitive.Root className="thread-root">
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
          <div className="welcome-card"><span className="welcome-kicker">{clinicalCopy.welcomeKicker}</span><h2>{clinicalCopy.welcomeTitle}</h2><p>{clinicalCopy.welcomeDescription}</p><QuickPrompts enabled={canSubmit} /></div>
          <ThreadPrimitive.Messages>
            {({ message }: { message: { id: string; role: string } }) => message.role === "user" ? (
              <MessagePrimitive.Root key={message.id} className="message-row user-message"><div className="user-message-card"><div className="message-label">您 · 本次复诊</div><MessagePrimitive.Parts /></div></MessagePrimitive.Root>
            ) : (
              <MessagePrimitive.Root key={message.id} className="message-row assistant-message">
                <div className="assistant-avatar" aria-hidden="true">H</div>
                <div className="assistant-message-body"><div className="message-label">{clinicalCopy.assistantLabel}</div>
                  <MessagePrimitive.Parts>{({ part }: { part: { type: string } }) => part.type === "text" ? <div className="assistant-markdown"><CitationMarkdown /><MessagePartPrimitive.InProgress><span className="stream-cursor" aria-label="正在生成">▍</span></MessagePartPrimitive.InProgress></div> : null}</MessagePrimitive.Parts>
                  <ActionBarPrimitive.Root className="message-actions"><ActionBarPrimitive.Reload className="text-action">重新生成</ActionBarPrimitive.Reload></ActionBarPrimitive.Root>
                </div>
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
          <ThreadPrimitive.ViewportFooter className="composer-footer">
            <ComposerPrimitive.Root className="composer-shell">
              <ComposerPrimitive.Input className="composer-input" placeholder={clinicalCopy.composerPlaceholder} aria-label={clinicalCopy.composerPlaceholder} disabled={!canSubmit} rows={2} />
              <div className="composer-toolbar"><span className="composer-hint">{clinicalCopy.composerPrivacyHint}</span><div className="composer-controls"><ComposerPrimitive.Cancel className="stop-button">停止</ComposerPrimitive.Cancel><ComposerPrimitive.Send className="send-button" disabled={!canSubmit}>发送 <span aria-hidden="true">↑</span></ComposerPrimitive.Send></div></div>
            </ComposerPrimitive.Root>
            <p className="composer-disclaimer">{clinicalCopy.disclaimer}{clinicalCopy.productionDecisionDisclaimer && <> {clinicalCopy.productionDecisionDisclaimer}</>}</p>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </section>
  </AssistantRuntimeProvider>;
}
