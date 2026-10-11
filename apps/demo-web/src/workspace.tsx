import { useCallback, useEffect, useRef, useState } from "react";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import { AgentActivity, BackendBadge, EvidenceActionProvider, EvidenceDrawer, PatientContext, toSafeActivityEvent, type EvidenceRecord } from "./components.js";
import type { Scenario, WireDemoEvent } from "./runtime/adapter.js";
import { applicationVersion, environmentLabel, isNonDemoBuild, runtimeConfig } from "./config/env.js";
import { clinicalCopy } from "@clinical-workstation-copy";
import { Consultation } from "./consultation.js";

export { Consultation } from "./consultation.js";

const API_BASE = import.meta.env.HUIYI_DEMO_API_BASE || "/api";

export function DemoWorkspace() {
  const [scenario, setScenario] = useState<Scenario>("simple");
  const [patientId, setPatientId] = useState<string | null>(isNonDemoBuild ? null : "patient-htn");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [backend, setBackend] = useState(isNonDemoBuild ? "unavailable" : "fixture");
  const [providerName, setProviderName] = useState(runtimeConfig.providerName ?? "");
  const [modelName, setModelName] = useState(runtimeConfig.modelName ?? "");
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
    const patientUrl = isNonDemoBuild
      ? runtimeConfig.patientContextUrl?.trim()
      : patientId ? `${API_BASE}/demo/patients/${encodeURIComponent(patientId)}` : undefined;
    if (!patientUrl || (isNonDemoBuild && patientUrl.includes("/demo/"))) {
      setPatient(null);
      setPatientLoading(false);
      setGatewayDown(false);
    } else {
      setPatientLoading(true);
      fetch(patientUrl, { signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error("PATIENT_CONTEXT_UNAVAILABLE"); return response.json() as Promise<PatientRecord>; })
        .then((value) => { setPatient(value); setGatewayDown(false); })
        .catch(() => { if (!controller.signal.aborted) { setPatient(null); setGatewayDown(true); } })
        .finally(() => { if (!controller.signal.aborted) setPatientLoading(false); });
    }
    fetch(`${API_BASE}/health`, { signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error("GATEWAY_UNAVAILABLE");
      return response.json();
    }).then((value: { backend?: string; providerName?: string; modelName?: string }) => {
      const reportedBackend = value.backend ?? (isNonDemoBuild ? "unavailable" : "fixture");
      const safeBackend = isNonDemoBuild && reportedBackend === "fixture" ? "unavailable" : reportedBackend;
      setBackend(safeBackend);
      setProviderName(runtimeConfig.providerName ?? value.providerName ?? "");
      setModelName(runtimeConfig.modelName ?? value.modelName ?? "");
      if (isNonDemoBuild && safeBackend === "unavailable") setGatewayDown(true);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [patientId]);

  eventHandlerRef.current = (event) => {
    const activityEvent = isNonDemoBuild ? toSafeActivityEvent(event) : event;
    if (activityEvent) setEvents((previous) => [...previous, activityEvent]);
    if (event.event === "run.started") setErrorCode(undefined);
    if (event.event === "evidence.item" && typeof event.data.evidenceId === "string") {
      setEvidence((previous) => previous.some((item) => item.evidenceId === event.data.evidenceId) ? previous : [...previous, event.data as unknown as EvidenceRecord]);
    }
  };
  errorHandlerRef.current = (code) => setErrorCode(code);

  const chooseScenario = (next: Scenario) => {
    if (isNonDemoBuild) return;
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
          <a className="brand" href="#home" aria-label="恩施慧宜眼科医院"><img className="brand-logo" src="/huiyi-logo.png" alt="恩施慧宜眼科医院" /></a>
          <div className="topbar-context"><span className="product-name">{clinicalCopy.productName}</span><span className="environment-badge">{environmentLabel}</span></div>
          <div className="topbar-actions"><BackendBadge backend={backend} providerName={providerName} modelName={modelName} /><button className="mobile-panel-button" onClick={() => setMobilePanel("patient")}>患者上下文</button><button className="mobile-panel-button" onClick={() => setMobilePanel("activity")}>Agent Activity</button><button className="new-session-button" onClick={startFreshTurn}>新建 Session <span>＋</span></button></div>
        </header>
        {gatewayDown && <div className="gateway-banner" role="alert"><span>{clinicalCopy.gatewayUnavailable}</span></div>}
        <main className="workstation-grid">
          <aside className={`side-column patient-column ${mobilePanel === "patient" ? "mobile-open" : ""}`}><button className="mobile-close" onClick={() => setMobilePanel(null)} aria-label="关闭患者上下文">×</button><PatientContext patient={patient} loading={patientLoading} /></aside>
          <Consultation key={sessionId} patientId={patient?.patientId ?? ""} sessionId={sessionId} scenario={scenario} canSubmit={isNonDemoBuild ? patient !== null && backend !== "unavailable" : backend !== "unavailable"} onEvent={onEvent} onError={onError} onRetry={startFreshTurn} onChooseScenario={chooseScenario} errorCode={errorCode} />
          <aside className={`side-column activity-column ${mobilePanel === "activity" ? "mobile-open" : ""}`}><button className="mobile-close" onClick={() => setMobilePanel(null)} aria-label="关闭 Agent Activity">×</button><AgentActivity events={events} errorCode={errorCode} />{!isNonDemoBuild && <section className="scenario-panel"><p className="eyebrow">{clinicalCopy.presentationLabel}</p><h2>{clinicalCopy.presentationTitle}</h2><button className="case-link" onClick={() => chooseScenario("simple")}><span className="case-index">01</span><span><strong>{clinicalCopy.simpleScenario}</strong><small>{clinicalCopy.singleTurnScenario}</small></span><span className="case-arrow">↗</span></button><button className="case-link" onClick={() => chooseScenario("complex")}><span className="case-index">02</span><span><strong>{clinicalCopy.complexScenario}</strong><small>{backend === "dsh" ? clinicalCopy.specialistScenario : clinicalCopy.simulatedSpecialistScenario}</small></span><span className="case-arrow">↗</span></button>{backend === "fixture" && <button className="case-link failure-case" onClick={() => { setScenario("failure"); setSessionId(crypto.randomUUID()); setEvents([]); setEvidence([]); setErrorCode(undefined); }}><span className="case-index">03</span><span><strong>{clinicalCopy.recoveryScenario}</strong><small>{clinicalCopy.recoveryDescription}</small></span><span className="case-arrow">↗</span></button>}</section>}</aside>
        </main>
        <footer className="global-footer">
          <div className="footer-runtime"><strong>Huiyi MedHarness · v{applicationVersion}</strong><span>{environmentLabel}</span><span>{backend === "fixture" && !isNonDemoBuild ? clinicalCopy.fixtureFooter : providerName && modelName ? `${providerName} · ${modelName}${clinicalCopy.footerRuntimeSuffix ? ` · ${clinicalCopy.footerRuntimeSuffix}` : ""}` : clinicalCopy.modelUnavailable}</span></div>
          <address className="organization-details">
            <span>主办单位 · <a href="http://www.huiyi9e.com/" title="湖北慧宜医疗管理集团有限公司" target="_blank" rel="noreferrer"><strong>湖北慧宜医疗管理集团有限公司</strong></a></span>
            <span>承办单位 · <a href="http://yk.huiyi9e.com/" title="恩施慧宜眼科医院有限责任公司" target="_blank" rel="noreferrer"><strong>恩施慧宜眼科医院有限责任公司</strong></a></span>
            <span>通信地址 · 湖北省恩施市金龙大道青树林区一号路</span>
            <span>办公电话 · <a href="tel:0718-8259000"><strong>0718-8259000</strong></a></span>
          </address>
          <div className="footer-actions"><button onClick={() => setEvidenceOpen(true)}>查看本轮证据 <span>{evidence.length}</span></button>{runtimeConfig.auditUrl && <a href={runtimeConfig.auditUrl}>审计记录</a>}</div>
        </footer>
        <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} backend={backend === "dsh" ? "dsh" : "fixture"} />
        {selectedEvidence && evidenceOpen && <span className="sr-only" aria-live="polite">已打开证据 {selectedEvidence}</span>}
        {mobilePanel && <button className="mobile-backdrop" onClick={() => setMobilePanel(null)} aria-label="关闭侧边栏" />}
      </div>
    </EvidenceActionProvider>
  );
}
