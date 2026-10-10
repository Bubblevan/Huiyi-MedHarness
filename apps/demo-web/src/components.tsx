import { useContext, createContext, type ReactNode } from "react";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import type { WireDemoEvent } from "./runtime/adapter.js";
import { isProductionBuild } from "./config/env.js";
import { clinicalCopy } from "./copy/clinicalWorkstation.js";

const EvidenceActionContext = createContext<(evidenceId: string) => void>(() => undefined);

export function EvidenceActionProvider({ onOpen, children }: { onOpen: (id: string) => void; children: ReactNode }) {
  return <EvidenceActionContext.Provider value={onOpen}>{children}</EvidenceActionContext.Provider>;
}

export function useEvidenceAction() { return useContext(EvidenceActionContext); }

export function BackendBadge({ backend, providerName, modelName }: { backend: string; providerName?: string; modelName?: string }) {
  const configuredModel = [providerName, modelName].filter((value) => typeof value === "string" && value.trim()).join(" · ");
  const label = backend === "fixture" && !isProductionBuild
    ? clinicalCopy.fixtureBackendLabel
    : backend === "dsh" && configuredModel
      ? configuredModel
      : clinicalCopy.modelUnavailable;
  return <span className="backend-badge"><span className="status-dot" />{label}</span>;
}

export function PatientContext({ patient, loading = false }: { patient: PatientRecord | null; loading?: boolean }) {
  if (loading) return <section className="panel patient-panel" aria-label="Patient Context"><p className="muted">{clinicalCopy.patientLoading}</p></section>;
  if (!patient) return <section className="panel patient-panel patient-empty" aria-label="Patient Context"><div><h2>{clinicalCopy.patientEmptyTitle}</h2><p>{clinicalCopy.patientEmptyHint}</p></div></section>;
  return (
    <section className="panel patient-panel" aria-label="Patient Context">
      <div className="panel-heading"><div><p className="eyebrow">PATIENT CONTEXT</p><h2>患者上下文</h2></div>{!isProductionBuild && <span className="synthetic-tag">{clinicalCopy.patientTag}</span>}</div>
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
      {!isProductionBuild && <p className="synthetic-note">{clinicalCopy.patientDataNote}</p>}
    </section>
  );
}

const EVENT_LABELS: Record<string, string> = {
  "run.started": "Session 已开始",
  "context.patient": "患者上下文已载入",
  "context.memory": "长期记忆快照已读取",
  "evidence.started": "医学证据检索开始",
  "evidence.item": "找到一条医学证据",
  "evidence.completed": "证据检索完成",
  "agent.classified": "复杂度已分类",
  "specialist.started": "专科协作开始",
  "specialist.completed": "专科协作完成",
  "collaboration.completed": "临床协作完成",
  "tool.started": "工具调用开始",
  "tool.completed": "工具调用完成",
  "assistant.delta": "回答正在生成",
  "run.completed": "本轮完成",
  "run.cancelled": "已停止本轮",
  "run.failed": "本轮未能完成",
};

const SAFE_ACTIVITY_EVENTS = new Set([
  "run.started", "context.patient", "context.memory", "evidence.started", "evidence.item",
  "evidence.completed", "agent.classified", "specialist.started", "specialist.completed",
  "collaboration.completed", "tool.started", "tool.completed", "assistant.delta",
  "run.completed", "run.cancelled", "run.failed",
]);

const SAFE_COMPLEXITIES = new Set(["simple", "low", "intermediate", "complex", "high"]);

/** Retain only bounded event metadata before storing a production activity trace. */
export function toSafeActivityEvent(event: WireDemoEvent): WireDemoEvent | null {
  if (!SAFE_ACTIVITY_EVENTS.has(event.event) || event.event === "assistant.delta") return null;
  const source = event.data;
  const data: Record<string, unknown> = {};
  const count = (key: string) => {
    const value = source[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) data[key] = value;
  };
  if (event.event === "context.memory") count("itemCount");
  if (event.event === "evidence.completed") count("count");
  if (event.event === "agent.classified" || event.event === "collaboration.completed") {
    const complexity = source.complexity;
    if (typeof complexity === "string" && SAFE_COMPLEXITIES.has(complexity)) data.complexity = complexity;
  }
  if (event.event === "collaboration.completed") {
    count("completedChildRuns");
    count("failedChildRuns");
    if (typeof source.degraded === "boolean") data.degraded = source.degraded;
  }
  return { ...event, runId: "redacted", sessionId: "redacted", data };
}

export function AgentActivity({ events, errorCode }: { events: WireDemoEvent[]; errorCode?: string }) {
  const summary = (event: WireDemoEvent): string => {
    if (isProductionBuild) {
      if (event.event === "context.memory" && typeof event.data.itemCount === "number") return `${event.data.itemCount} 条摘要项`;
      if (event.event === "evidence.completed" && typeof event.data.count === "number") return `${event.data.count} 条 · 本地医学语料`;
      if (event.event === "agent.classified" && typeof event.data.complexity === "string") return event.data.complexity;
      if (event.event === "collaboration.completed") {
        const completed = typeof event.data.completedChildRuns === "number" ? event.data.completedChildRuns : 0;
        const failed = typeof event.data.failedChildRuns === "number" ? event.data.failedChildRuns : 0;
        return `${completed} 项完成${failed ? ` / ${failed} 项未完成` : ""}${event.data.degraded ? " · 降级" : ""}`;
      }
      return "";
    }
    if (event.event === "context.memory") return `${String(event.data.itemCount ?? 0)} 条摘要项`;
    if (event.event === "evidence.completed") return `${String(event.data.count ?? 0)} 条 · 本地医学语料`;
    if (event.event === "agent.classified") return `${String(event.data.complexity ?? "unknown")}${event.data.simulated ? " · simulated execution" : ""}`;
    if (event.event === "specialist.started" || event.event === "specialist.completed") return `${String(event.data.specialist ?? "专科")}${event.data.simulated ? " · simulated execution" : " · DSH child"}`;
    if (event.event === "collaboration.completed") {
      const roles = Array.isArray(event.data.specialistRoles) ? event.data.specialistRoles.join(" / ") : "";
      const failures = Number(event.data.failedChildRuns ?? 0);
      return `${String(event.data.complexity)} · ${roles || "无专家"} · ${String(event.data.completedChildRuns ?? 0)} 完成${failures ? ` / ${failures} 失败` : ""}${event.data.degraded ? " · 降级" : ""}`;
    }
    if (event.event === "tool.started" || event.event === "tool.completed") return String(event.data.tool ?? "医学检索工具");
    if (event.event === "run.failed") return String(event.data.code ?? "BACKEND_UNAVAILABLE");
    return "";
  };
  const visible = events.filter((event) => event.event !== "assistant.delta");
  return (
    <section className="panel activity-panel" aria-label="Agent Activity">
      <div className="panel-heading"><div><p className="eyebrow">EXECUTION TRACE</p><h2>Agent Activity</h2></div><span className="trace-count">{visible.length.toString().padStart(2, "0")}</span></div>
      <p className="activity-caption">{clinicalCopy.activityCaption}</p>
      {errorCode && <div className="error-inline" role="status"><span className="error-indicator" />{clinicalCopy.serviceUnavailable}{!isProductionBuild && <code>{errorCode}</code>}</div>}
      <ol className="activity-list" aria-live="polite">
        {visible.length === 0 && <li className="activity-empty">{clinicalCopy.activityEmpty}</li>}
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

export function EvidenceDrawer({ open, items, onClose, backend = "fixture" }: { open: boolean; items: EvidenceRecord[]; onClose: () => void; backend?: "fixture" | "dsh" }) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-label="Evidence Sources">
        <div className="drawer-grabber" />
        <div className="drawer-heading"><div><p className="eyebrow">SOURCE REVIEW</p><h2>医学证据来源</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭证据抽屉">×</button></div>
        <span className="fixture-tag">{backend === "dsh" || isProductionBuild ? "本地医学检索结果" : clinicalCopy.fixtureEvidenceLabel}</span>
        {items.length === 0 || (isProductionBuild && backend === "fixture") ? <p className="muted">本轮尚无可展示的证据。</p> : <div className="evidence-list">{items.map((item) => <article className="evidence-card" key={item.evidenceId} id={item.evidenceId}>
          <div className="evidence-card-top"><span className="citation-index">[{item.rank}]</span><code>{item.evidenceId}</code></div>
          <p className="evidence-source">{item.source}</p><h3>{item.title}</h3><p className="evidence-snippet">{item.snippet}</p>
        </article>)}</div>}
        <p className="evidence-disclaimer">{backend === "dsh" || isProductionBuild ? clinicalCopy.evidenceDisclaimer : clinicalCopy.fixtureEvidenceDisclaimer}</p>
      </aside>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-notice" role="alert"><span className="error-indicator" /><div><strong>{clinicalCopy.serviceUnavailable}</strong><p>{message}</p></div>{onRetry && <button onClick={onRetry}>{clinicalCopy.retry}</button>}</div>;
}
