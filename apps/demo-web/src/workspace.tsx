import { useCallback, useEffect, useRef, useState } from "react";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import { EvidenceActionProvider, EvidenceDrawer, PatientContext, type EvidenceRecord } from "./components.js";
import type { Scenario, WireDemoEvent } from "./runtime/adapter.js";
import { createSessionId } from "./runtime/sessionId.js";
import { isNonDemoBuild, runtimeConfig } from "./config/env.js";
import { clinicalCopy } from "@clinical-workstation-copy";
import { Consultation } from "./consultation.js";

export { Consultation } from "./consultation.js";

const API_BASE = import.meta.env.HUIYI_DEMO_API_BASE || "/api";

export function DemoWorkspace() {
  const [scenario, setScenario] = useState<Scenario>("simple");
  const [patientId, setPatientId] = useState<string | null>(isNonDemoBuild ? null : "patient-htn");
  const [sessionId, setSessionId] = useState(() => createSessionId());
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [backend, setBackend] = useState(isNonDemoBuild ? "unavailable" : "fixture");
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string>();
  const [gatewayDown, setGatewayDown] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"patient" | null>(null);
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
    }).then((value: { backend?: string }) => {
      const reportedBackend = value.backend ?? (isNonDemoBuild ? "unavailable" : "fixture");
      const safeBackend = isNonDemoBuild && reportedBackend === "fixture" ? "unavailable" : reportedBackend;
      setBackend(safeBackend);
      if (isNonDemoBuild && safeBackend === "unavailable") setGatewayDown(true);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [patientId]);

  eventHandlerRef.current = (event) => {
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
    setSessionId(createSessionId());
    setEvidence([]);
    setErrorCode(undefined);
  };
  const startFreshTurn = () => {
    setSessionId(createSessionId());
    setEvidence([]);
    setErrorCode(undefined);
  };
  const openEvidence = (evidenceId: string) => { setSelectedEvidence(evidenceId); setEvidenceOpen(true); };

  return (
    <EvidenceActionProvider onOpen={openEvidence}>
      <div className="workstation-shell">
        <header className="topbar">
          <a className="brand" href="#home" aria-label="恩施慧宜眼科医院"><img className="brand-logo" src="/huiyi-logo.png" alt="恩施慧宜眼科医院" /></a>
          <div className="topbar-context"><span className="product-name">{clinicalCopy.productName}</span></div>
          <div className="topbar-actions"><button className="mobile-panel-button" onClick={() => setMobilePanel("patient")}>患者信息</button><button className="new-session-button" aria-label="新建会话" onClick={startFreshTurn}>新建会话 <span aria-hidden="true">＋</span></button></div>
        </header>
        {gatewayDown && <div className="gateway-banner" role="alert"><span>{clinicalCopy.gatewayUnavailable}</span></div>}
        <main className="workstation-grid clinician-grid">
          <aside className={`side-column patient-column ${mobilePanel === "patient" ? "mobile-open" : ""}`}><button className="mobile-close" onClick={() => setMobilePanel(null)} aria-label="关闭患者信息">×</button><PatientContext patient={patient} loading={patientLoading} /></aside>
          <Consultation key={sessionId} patientId={patient?.patientId ?? ""} sessionId={sessionId} scenario={scenario} showInternalMetadata={false} canSubmit={patient !== null && backend !== "unavailable" && !gatewayDown} onEvent={onEvent} onError={onError} onRetry={startFreshTurn} onChooseScenario={chooseScenario} errorCode={errorCode} />
        </main>
        <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} backend={backend === "dsh" ? "dsh" : "fixture"} />
        {selectedEvidence && evidenceOpen && <span className="sr-only" aria-live="polite">已打开证据 {selectedEvidence}</span>}
        {mobilePanel && <button className="mobile-backdrop" onClick={() => setMobilePanel(null)} aria-label="关闭侧边栏" />}
      </div>
    </EvidenceActionProvider>
  );
}
