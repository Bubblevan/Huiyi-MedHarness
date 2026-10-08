import { useContext, createContext, type ReactNode } from "react";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import type { WireDemoEvent } from "./runtime/adapter.js";

const EvidenceActionContext = createContext<(evidenceId: string) => void>(() => undefined);

export function EvidenceActionProvider({ onOpen, children }: { onOpen: (id: string) => void; children: ReactNode }) {
  return <EvidenceActionContext.Provider value={onOpen}>{children}</EvidenceActionContext.Provider>;
}

export function useEvidenceAction() { return useContext(EvidenceActionContext); }

export function BackendBadge({ backend }: { backend: string }) {
  return <span className="backend-badge"><span className="status-dot" />{backend === "fixture" ? "Local · fixture" : "Local · DSH boundary"}</span>;
}

export function PatientContext({ patient, loading = false }: { patient: PatientRecord | null; loading?: boolean }) {
  if (loading) return <section className="panel patient-panel" aria-label="Patient Context"><p className="muted">正在载入合成患者…</p></section>;
  if (!patient) return <section className="panel patient-panel" aria-label="Patient Context"><p className="muted">合成患者资料暂不可用。</p></section>;
  return (
    <section className="panel patient-panel" aria-label="Patient Context">
      <div className="panel-heading"><div><p className="eyebrow">PATIENT CONTEXT</p><h2>患者上下文</h2></div><span className="synthetic-tag">Synthetic demo patient</span></div>
      <div className="patient-identity">
        <div className="patient-avatar">{patient.displayName.slice(0, 1)}</div>
        <div><h3>{patient.displayName}</h3><p>{patient.sex} · {patient.age} 岁</p></div>
      </div>
      <div className="encounter-chip"><span className="small-label">当前 Encounter</span><strong>{patient.encounter}</strong></div>
      <section className="clinical-section"><h3>已知问题 <span>{patient.conditions.length}</span></h3><ul>{patient.conditions.map((condition) => <li key={condition}><span className="clinical-mark amber" />{condition}</li>)}</ul></section>
      <section className="clinical-section"><h3>用药记录 <span>{patient.medications.length}</span></h3><ul>{patient.medications.map((medication) => <li key={medication}><span className="clinical-mark blue" />{medication}</li>)}</ul></section>
      <section className="clinical-section"><h3>过敏信息</h3><ul>{patient.allergies.map((allergy) => <li key={allergy}><span className="clinical-mark green" />{allergy}</li>)}</ul></section>
      <section className="memory-card" aria-label="Longitudinal Memory">
        <div className="memory-heading"><span className="memory-icon">M</span><div><h3>长期记忆摘要</h3><span>{patient.memory.items} 条 · {patient.memory.updatedLabel}</span></div></div>
        <p>{patient.memory.summary}</p>
        <small>患者历史上下文 · 与医学证据分开</small>
      </section>
      <p className="synthetic-note">所有姓名、病程与内容均为合成演示数据。</p>
    </section>
  );
}

const EVENT_LABELS: Record<string, string> = {
  "run.started": "Session 已开始",
  "context.patient": "患者上下文已载入",
  "context.memory": "长期记忆快照已读取",
  "evidence.started": "医学证据检索开始",
  "evidence.item": "找到一条合成证据",
  "evidence.completed": "证据检索完成",
  "agent.classified": "复杂度已分类",
  "specialist.started": "专科协作开始",
  "specialist.completed": "专科协作完成",
  "tool.started": "工具调用开始",
  "tool.completed": "工具调用完成",
  "assistant.delta": "回答正在生成",
  "run.completed": "本轮完成",
  "run.cancelled": "已停止本轮",
  "run.failed": "本轮未能完成",
};

export function AgentActivity({ events, errorCode }: { events: WireDemoEvent[]; errorCode?: string }) {
  const summary = (event: WireDemoEvent): string => {
    if (event.event === "context.memory") return `${String(event.data.itemCount ?? 0)} 条摘要项`;
    if (event.event === "evidence.completed") return `${String(event.data.count ?? 0)} 条 · Demo evidence fixture`;
    if (event.event === "agent.classified") return `${event.data.complexity === "intermediate" ? "中等复杂度" : "简单"}${event.data.simulated ? " · simulated execution" : ""}`;
    if (event.event === "specialist.started" || event.event === "specialist.completed") return `${String(event.data.specialist ?? "专科")} · simulated execution`;
    if (event.event === "tool.started" || event.event === "tool.completed") return String(event.data.tool ?? "医学检索工具");
    if (event.event === "run.failed") return String(event.data.code ?? "BACKEND_UNAVAILABLE");
    return "";
  };
  const visible = events.filter((event) => event.event !== "assistant.delta");
  return (
    <section className="panel activity-panel" aria-label="Agent Activity">
      <div className="panel-heading"><div><p className="eyebrow">EXECUTION TRACE</p><h2>Agent Activity</h2></div><span className="trace-count">{visible.length.toString().padStart(2, "0")}</span></div>
      <p className="activity-caption">仅显示结构化执行元数据</p>
      {errorCode && <div className="error-inline" role="status"><span className="error-indicator" />服务暂时不可用，请稍后重试。<code>{errorCode}</code></div>}
      <ol className="activity-list" aria-live="polite">
        {visible.length === 0 && <li className="activity-empty">发送问题后，执行活动会显示在这里。</li>}
        {visible.map((event, index) => <li key={`${event.runId}-${event.event}-${index}`} className={`activity-item event-${event.event.replaceAll(".", "-")}`}>
          <span className={`activity-marker ${event.event === "run.failed" ? "failure" : event.event === "run.completed" ? "success" : ""}`} aria-hidden="true">{event.event === "run.completed" ? "✓" : event.event === "run.failed" ? "!" : "·"}</span>
          <div><strong>{EVENT_LABELS[event.event] ?? "执行步骤"}</strong>{summary(event) && <span className="activity-detail">{summary(event)}</span>}<time>{new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>
        </li>)}
      </ol>
      <div className="trace-legend"><span className="legend-key memory-key" />Memory <span className="legend-key evidence-key" />Evidence <span className="legend-key specialist-key" />Specialists</div>
    </section>
  );
}

export interface EvidenceRecord {
  evidenceId: string;
  rank: number;
  source: string;
  title: string;
  snippet: string;
}

export function EvidenceDrawer({ open, items, onClose }: { open: boolean; items: EvidenceRecord[]; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-label="Evidence Sources">
        <div className="drawer-grabber" />
        <div className="drawer-heading"><div><p className="eyebrow">SOURCE REVIEW</p><h2>医学证据来源</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭证据抽屉">×</button></div>
        <span className="fixture-tag">Demo evidence fixture</span>
        {items.length === 0 ? <p className="muted">本轮尚无可展示的合成证据。</p> : <div className="evidence-list">{items.map((item) => <article className="evidence-card" key={item.evidenceId} id={item.evidenceId}>
          <div className="evidence-card-top"><span className="citation-index">[{item.rank}]</span><code>{item.evidenceId}</code></div>
          <p className="evidence-source">{item.source}</p><h3>{item.title}</h3><p className="evidence-snippet">{item.snippet}</p>
        </article>)}</div>}
        <p className="evidence-disclaimer">这些条目是为界面验收编写的合成资料，不是已核实的医学证据或医疗建议。</p>
      </aside>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-notice" role="alert"><span className="error-indicator" /><div><strong>服务暂时不可用，请稍后重试。</strong><p>{message}</p></div>{onRetry && <button onClick={onRetry}>重试</button>}</div>;
}
