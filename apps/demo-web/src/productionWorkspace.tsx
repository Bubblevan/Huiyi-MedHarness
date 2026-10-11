import { useMemo, useState } from "react";
import { AgentActivity, BackendBadge, EvidenceActionProvider, EvidenceDrawer, PatientContext, type EvidenceRecord } from "./components.js";
import { applicationVersion, environmentLabel, runtimeConfig } from "./config/env.js";
import { Consultation } from "./consultation.js";
import type { WireDemoEvent } from "./runtime/adapter.js";

export function ProductionWorkspace() {
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence] = useState<EvidenceRecord[]>([]);
  const [events] = useState<WireDemoEvent[]>([]);
  const providerName = runtimeConfig.providerName ?? "";
  const modelName = runtimeConfig.modelName ?? "";
  const provider = [providerName, modelName].filter(Boolean).join(" · ");
  return <EvidenceActionProvider onOpen={() => setEvidenceOpen(true)}>
    <div className="workstation-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="恩施慧宜眼科医院"><img className="brand-logo" src="/huiyi-logo.png" alt="恩施慧宜眼科医院" /></a>
        <div className="topbar-context"><span className="product-name">临床工作台</span><span className="environment-badge">{environmentLabel}</span></div>
        <div className="topbar-actions"><BackendBadge backend="unavailable" providerName={providerName} modelName={modelName} /></div>
      </header>
      <main className="workstation-grid">
        <aside className="side-column patient-column"><PatientContext patient={null} /></aside>
        <Consultation patientId="" sessionId={sessionId} scenario="simple" includeScenario={false} canSubmit={false} onEvent={() => undefined} onError={() => undefined} onRetry={() => undefined} onChooseScenario={() => undefined} />
        <aside className="side-column activity-column"><AgentActivity events={events} /></aside>
      </main>
      <footer className="global-footer">
        <div className="footer-runtime"><strong>Huiyi MedHarness · v{applicationVersion}</strong><span>{environmentLabel}</span><span>{provider || "模型信息暂不可用"}</span></div>
        <address className="organization-details">
          <span>主办单位 · <a href="http://www.huiyi9e.com/" title="湖北慧宜医疗管理集团有限公司" target="_blank" rel="noreferrer"><strong>湖北慧宜医疗管理集团有限公司</strong></a></span>
          <span>承办单位 · <a href="http://yk.huiyi9e.com/" title="恩施慧宜眼科医院有限责任公司" target="_blank" rel="noreferrer"><strong>恩施慧宜眼科医院有限责任公司</strong></a></span>
          <span>通信地址 · 湖北省恩施市金龙大道青树林区一号路</span>
          <span>办公电话 · <a href="tel:0718-8259000"><strong>0718-8259000</strong></a></span>
        </address>
        <div className="footer-actions"><span>仅显示脱敏执行元数据</span>{runtimeConfig.auditUrl && <a href={runtimeConfig.auditUrl}>审计记录</a>}</div>
      </footer>
      <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} backend="dsh" />
    </div>
  </EvidenceActionProvider>;
}
