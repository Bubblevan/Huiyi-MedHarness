import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
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
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import { AgentActivity, BackendBadge, ErrorNotice, EvidenceActionProvider, EvidenceDrawer, PatientContext, useEvidenceAction, type EvidenceRecord } from "./components.js";
import { createDemoAdapter, type Scenario, type WireDemoEvent } from "./runtime/adapter.js";

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

function QuickPrompts() {
  const aui = useAui();
  return <div className="quick-prompts"><button onClick={() => void aui.composer.setText("请根据本次复诊情况，帮我整理需要记录和向医生确认的问题。")}>整理复诊问题 <span>↗</span></button><button onClick={() => void aui.composer.setText("请根据已有上下文，给我一个简洁的下一步沟通清单。")}>生成沟通清单 <span>↗</span></button></div>;
}

function Consultation({ patientId, sessionId, scenario, onEvent, onError, onRetry, onChooseScenario, errorCode }: {
  patientId: string; sessionId: string; scenario: Scenario;
  onEvent: (event: WireDemoEvent) => void; onError: (code: string) => void; onRetry: () => void; onChooseScenario: (scenario: Scenario) => void; errorCode?: string;
}) {
  const adapter = useMemo<ChatModelAdapter>(() => createDemoAdapter({ patientId, sessionId, scenario, onEvent, onError, apiBase: API_BASE }), [patientId, sessionId, scenario, onEvent, onError]);
  const runtime = useLocalRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>
    <section className="consultation" aria-label="Consultation">
      <header className="consultation-header">
        <div><p className="eyebrow">CONSULTATION</p><h1>复诊工作台</h1></div>
        <div className="session-meta"><span><i /> Encounter</span><span>Session <code>{sessionId.slice(0, 8)}</code></span></div>
      </header>
      <div className="scenario-strip" aria-label="演示案例">
        <div><span className="scenario-label">DEMO SCENARIOS</span><span>选择案例开始对话</span></div>
        <div className="scenario-actions"><button className={scenario === "simple" ? "scenario-button selected" : "scenario-button"} onClick={() => onChooseScenario("simple")} title="开始高血压复诊场景">高血压复诊</button><span className="scenario-separator">/</span><span className="scenario-current">{scenario === "complex" ? "复杂病例" : scenario === "failure" ? "故障演示" : "当前案例"}</span></div>
      </div>
      {errorCode && <div className="consultation-error"><ErrorNotice message={`执行状态：${errorCode}`} onRetry={onRetry} /></div>}
      <ThreadPrimitive.Root className="thread-root">
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
          <div className="welcome-card"><span className="welcome-kicker">SYNTHETIC CASE</span><h2>从患者上下文开始</h2><p>患者长期记忆与合成证据分别展示。回答只用于演示界面流程。</p>
            <QuickPrompts />
          </div>
          <ThreadPrimitive.Messages>
            {({ message }: { message: { id: string; role: string } }) => message.role === "user" ? (
              <MessagePrimitive.Root key={message.id} className="message-row user-message">
                <div className="user-message-card"><div className="message-label">您 · 本次复诊</div><MessagePrimitive.Parts /></div>
              </MessagePrimitive.Root>
            ) : (
              <MessagePrimitive.Root key={message.id} className="message-row assistant-message">
                <div className="assistant-avatar" aria-hidden="true">H</div>
                <div className="assistant-message-body"><div className="message-label">Huiyi · 合成演示回答</div>
                  <MessagePrimitive.Parts>{({ part }: { part: { type: string } }) => part.type === "text" ? <div className="assistant-markdown"><CitationMarkdown /><MessagePartPrimitive.InProgress><span className="stream-cursor" aria-label="正在生成">▍</span></MessagePartPrimitive.InProgress></div> : null}</MessagePrimitive.Parts>
                  <ActionBarPrimitive.Root className="message-actions"><ActionBarPrimitive.Reload className="text-action">重新生成</ActionBarPrimitive.Reload></ActionBarPrimitive.Root>
                </div>
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
          <ThreadPrimitive.ViewportFooter className="composer-footer">
            <ComposerPrimitive.Root className="composer-shell">
              <ComposerPrimitive.Input className="composer-input" placeholder="描述本次复诊问题…" aria-label="描述本次复诊问题" rows={2} />
              <div className="composer-toolbar"><span className="composer-hint">合成演示 · 请勿输入真实患者信息</span><div className="composer-controls">
                <ComposerPrimitive.Cancel className="stop-button">停止</ComposerPrimitive.Cancel>
                <ComposerPrimitive.Send className="send-button">发送 <span aria-hidden="true">↑</span></ComposerPrimitive.Send>
              </div></div>
            </ComposerPrimitive.Root>
            <p className="composer-disclaimer">演示输出不构成诊断或治疗建议，请由医疗专业人员结合完整病史判断。</p>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </section>
  </AssistantRuntimeProvider>;
}

export function DemoWorkspace() {
  const [scenario, setScenario] = useState<Scenario>("simple");
  const [patientId, setPatientId] = useState("patient-htn");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [backend, setBackend] = useState("fixture");
  const [events, setEvents] = useState<WireDemoEvent[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string>();
  const [gatewayDown, setGatewayDown] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"patient" | "activity" | null>(null);
  const eventHandlerRef = useRef<(event: WireDemoEvent) => void>(() => undefined);
  const errorHandlerRef = useRef<(code: string) => void>(() => undefined);
  const onEvent = useCallback((event: WireDemoEvent) => eventHandlerRef.current(event), []);
  const onError = useCallback((code: string) => errorHandlerRef.current(code), []);

  useEffect(() => {
    const controller = new AbortController();
    setPatientLoading(true);
    fetch(`${API_BASE}/demo/patients/${encodeURIComponent(patientId)}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("INVALID_FIXTURE_PATIENT"); return response.json() as Promise<PatientRecord>; })
      .then((value) => { setPatient(value); setGatewayDown(false); })
      .catch(() => { if (!controller.signal.aborted) { setPatient(null); setGatewayDown(true); } })
      .finally(() => { if (!controller.signal.aborted) setPatientLoading(false); });
    fetch(`${API_BASE}/health`, { signal: controller.signal }).then((response) => response.json()).then((value: { backend?: string }) => setBackend(value.backend ?? "fixture")).catch(() => undefined);
    return () => controller.abort();
  }, [patientId]);

  eventHandlerRef.current = (event) => {
    setEvents((previous) => [...previous, event]);
    if (event.event === "run.started") setErrorCode(undefined);
    if (event.event === "evidence.item" && typeof event.data.evidenceId === "string") {
      setEvidence((previous) => previous.some((item) => item.evidenceId === event.data.evidenceId) ? previous : [...previous, event.data as unknown as EvidenceRecord]);
    }
  };
  errorHandlerRef.current = (code) => setErrorCode(code);

  const chooseScenario = (next: Scenario) => {
    setScenario(next);
    if (next === "complex") setPatientId("patient-complex");
    if (next === "simple") setPatientId("patient-htn");
    setSessionId(crypto.randomUUID());
    setEvents([]);
    setEvidence([]);
    setErrorCode(undefined);
  };
  const startFreshTurn = () => {
    setSessionId(crypto.randomUUID());
    setEvents([]);
    setEvidence([]);
    setErrorCode(undefined);
  };
  const openEvidence = (evidenceId: string) => { setSelectedEvidence(evidenceId); setEvidenceOpen(true); };

  return (
    <EvidenceActionProvider onOpen={openEvidence}>
      <div className="workstation-shell">
        <header className="topbar">
          <a className="brand" href="#home" aria-label="Huiyi MedHarness home"><span className="brand-mark">H</span><span><strong>Huiyi</strong><small>MEDHARNESS</small></span></a>
          <div className="topbar-context"><span className="product-name">Clinical Demo Workstation</span><span className="environment-badge">DEMO / LOCAL</span></div>
          <div className="topbar-actions"><BackendBadge backend={backend} /><button className="mobile-panel-button" onClick={() => setMobilePanel("patient")}>患者上下文</button><button className="mobile-panel-button" onClick={() => setMobilePanel("activity")}>Agent Activity</button><button className="new-session-button" onClick={startFreshTurn}>新建 Session <span>＋</span></button></div>
        </header>
        {gatewayDown && <div className="gateway-banner" role="alert"><span>Demo Gateway 暂不可用。</span><span>确认 Gateway 已在本机启动后刷新此页面。</span></div>}
        <main className="workstation-grid">
          <aside className={`side-column patient-column ${mobilePanel === "patient" ? "mobile-open" : ""}`}><button className="mobile-close" onClick={() => setMobilePanel(null)} aria-label="关闭患者上下文">×</button><PatientContext patient={patient} loading={patientLoading} /></aside>
          <Consultation key={sessionId} patientId={patientId} sessionId={sessionId} scenario={scenario} onEvent={onEvent} onError={onError} onRetry={startFreshTurn} onChooseScenario={chooseScenario} errorCode={errorCode} />
          <aside className={`side-column activity-column ${mobilePanel === "activity" ? "mobile-open" : ""}`}><button className="mobile-close" onClick={() => setMobilePanel(null)} aria-label="关闭 Agent Activity">×</button><AgentActivity events={events} errorCode={errorCode} /><section className="scenario-panel"><p className="eyebrow">PRESENTATION CASES</p><h2>演示案例</h2><button className="case-link" onClick={() => chooseScenario("simple")}><span className="case-index">01</span><span><strong>高血压复诊</strong><small>单轮上下文与证据</small></span><span className="case-arrow">↗</span></button><button className="case-link" onClick={() => chooseScenario("complex")}><span className="case-index">02</span><span><strong>复杂病例</strong><small>simulated multi-specialist flow</small></span><span className="case-arrow">↗</span></button><button className="case-link failure-case" onClick={() => { setScenario("failure"); setSessionId(crypto.randomUUID()); setEvents([]); setEvidence([]); setErrorCode(undefined); }}><span className="case-index">03</span><span><strong>故障与恢复</strong><small>验证错误状态与重试</small></span><span className="case-arrow">↗</span></button></section></aside>
        </main>
        <footer className="global-footer"><span>Huiyi MedHarness</span><span>CPU-only fixture acceptance · 合成数据 · 本地运行</span><button onClick={() => setEvidenceOpen(true)}>查看本轮证据 <span>{evidence.length}</span></button></footer>
        <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} />
        {selectedEvidence && evidenceOpen && <span className="sr-only" aria-live="polite">已打开证据 {selectedEvidence}</span>}
        {mobilePanel && <button className="mobile-backdrop" onClick={() => setMobilePanel(null)} aria-label="关闭侧边栏" />}
      </div>
    </EvidenceActionProvider>
  );
}
