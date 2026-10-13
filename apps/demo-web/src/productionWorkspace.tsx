import { useMemo, useState } from "react";
import { EvidenceActionProvider, EvidenceDrawer, PatientContext, type EvidenceRecord } from "./components.js";
import { createSessionId } from "./runtime/sessionId.js";
import { Consultation } from "./consultation.js";
import { clinicalCopy } from "@clinical-workstation-copy";

export function ProductionWorkspace() {
  const sessionId = useMemo(() => createSessionId(), []);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence] = useState<EvidenceRecord[]>([]);
  return <EvidenceActionProvider onOpen={() => setEvidenceOpen(true)}>
    <div className="workstation-shell production-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="恩施慧宜眼科医院"><img className="brand-logo" src="/huiyi-logo.png" alt="恩施慧宜眼科医院" /></a>
        <div className="topbar-context"><span className="product-name">{clinicalCopy.productName}</span></div>
      </header>
      <main className="workstation-grid production-grid">
        <aside className="side-column patient-column"><PatientContext patient={null} /></aside>
        <Consultation patientId="" sessionId={sessionId} scenario="simple" includeScenario={false} showInternalMetadata={false} canSubmit={false} onEvent={() => undefined} onError={() => undefined} onRetry={() => undefined} onChooseScenario={() => undefined} />
      </main>
      <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} backend="dsh" />
    </div>
  </EvidenceActionProvider>;
}
