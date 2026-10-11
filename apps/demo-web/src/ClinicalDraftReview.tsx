import { useEffect, useMemo, useState } from "react";
import type { ClinicalDraftSection, ClinicalReviewDraft, DraftChange, DraftItemDisposition, DraftReviewAction } from "../../../services/demo-gateway/src/clinical-drafts/registry.js";

const SECTION_ORDER: readonly { id: ClinicalDraftSection; title: string }[] = [
  { id: "chiefConcern", title: "主诉与病情变化" },
  { id: "history", title: "既往重要病史" },
  { id: "medications", title: "当前用药" },
  { id: "allergies", title: "过敏信息" },
  { id: "symptomsAndTests", title: "本次症状与检查摘要" },
  { id: "informationToVerify", title: "待医生核实的信息" },
  { id: "riskSignals", title: "风险相关信息" },
  { id: "medicalEvidence", title: "医学证据与出处" },
  { id: "assistantResponses", title: "模型生成回复" },
  { id: "uncertainty", title: "不确定性与缺失信息" },
];

interface LocalEdit extends DraftChange {}

export function ClinicalDraftReview({
  draft,
  busy = false,
  error,
  onSubmit,
}: {
  draft: Omit<ClinicalReviewDraft, "owner"> | null;
  busy?: boolean;
  error?: string;
  onSubmit: (input: { action: DraftReviewAction; changes: readonly DraftChange[]; expectedVersion: number }) => Promise<void>;
}) {
  const [edits, setEdits] = useState<Map<string, LocalEdit>>(new Map());
  useEffect(() => setEdits(new Map()), [draft?.draftId, draft?.version]);
  const changeCount = edits.size;
  const sectionItems = useMemo(() => SECTION_ORDER.flatMap((section) => {
    const items = draft?.sections[section.id] ?? [];
    return items.length ? [{ ...section, items }] : section.id === "riskSignals" ? [{ ...section, items: [] }] : [];
  }), [draft]);

  if (!draft) return <section className="clinical-draft-review draft-empty" aria-label="复诊材料审核">
    <div>{error && <p className="draft-review-error" role="alert">{error}</p>}<p className="eyebrow">FOLLOW-UP DRAFT</p><h2>复诊材料草稿</h2><p>完成一轮咨询后，系统会根据授权的合成就诊上下文生成初步草稿。</p><span className="draft-empty-badge">合成工作流 · 草稿尚未生成</span></div>
  </section>;

  const setEdit = (section: ClinicalDraftSection, itemId: string, update: Partial<LocalEdit>) => {
    const key = `${section}\0${itemId}`;
    setEdits((previous) => {
      const next = new Map(previous);
      const current = next.get(key) ?? { section, itemId };
      next.set(key, { ...current, ...update });
      return next;
    });
  };
  const submit = (action: DraftReviewAction) => onSubmit({ action, changes: [...edits.values()], expectedVersion: draft.version });

  return <section className="clinical-draft-review" aria-label="复诊材料审核">
    <header className="draft-review-header">
      <div><p className="eyebrow">PRELIMINARY · SYNTHETIC</p><h2>复诊材料草稿</h2><p>{draft.patientId} · {draft.encounterId} · v{draft.version}</p></div>
      <span className={`draft-state draft-state-${draft.status}`}>{workflowLabel(draft.status)}</span>
    </header>
    <div className="draft-review-notice" role="note">仅用于合成工作流审核演示。演示审核状态不会记录为执业医师临床批准，也不会写入真实 EMR。</div>
    {error && <p className="draft-review-error" role="alert">{error}</p>}
    <div className="draft-sections">
      {sectionItems.map((section) => <section className="draft-section" key={section.id} aria-label={section.title}>
        <div className="draft-section-title"><h3>{section.title}</h3>{section.id === "riskSignals" && <span>未筛查 ≠ 无风险</span>}</div>
        {section.items.length === 0 ? <p className="draft-no-items">暂无可结构化条目；不代表已完成核实。</p> : section.items.map((item) => {
          const local = edits.get(`${section.id}\0${item.itemId}`);
          return <article className="draft-item" key={item.itemId}>
            <label className="draft-item-label" htmlFor={`draft-${item.itemId}`}>{item.label}</label>
            <textarea id={`draft-${item.itemId}`} rows={item.value.length > 320 ? 5 : item.value.length > 90 ? 3 : 2}
              value={local?.value ?? item.value} onChange={(event) => setEdit(section.id, item.itemId, { value: event.target.value })}
              disabled={busy} maxLength={8_000} />
            <div className="draft-item-meta"><span>来源：{item.source.label}</span><span>审核：{dispositionLabel(local?.disposition ?? item.disposition)}</span></div>
            <div className="draft-item-actions">
              <button type="button" disabled={busy} onClick={() => setEdit(section.id, item.itemId, { disposition: "confirmed-in-demo" })}>确认（演示）</button>
              <button type="button" disabled={busy} onClick={() => setEdit(section.id, item.itemId, { disposition: "rejected-in-demo" })}>退回核实</button>
            </div>
          </article>;
        })}
      </section>)}
    </div>
    <details className="draft-conversation-detail"><summary>本轮咨询与证据关联（{draft.turns.length} 轮）</summary>
      {draft.turns.map((turn) => <article key={turn.runId} className="draft-turn-record">
        <p><strong>患者描述</strong><span>{turn.patientMessage}</span></p>
        <p><strong>模型回复</strong><span>{turn.assistantResponse}</span></p>
        <small>运行 {turn.runId} · {new Date(turn.occurredAt).toLocaleString("zh-CN")} · 证据 {turn.evidenceIds.length} 项</small>
      </article>)}
    </details>
    <details className="draft-audit-history"><summary>审核版本与操作记录（{draft.revisions.length} 条）</summary>
      {draft.revisions.map((revision) => <article className="draft-revision" key={`${revision.version}-${revision.occurredAt}`}>
        <strong>v{revision.version} · {actionLabel(revision.action)}</strong>
        <span>{revision.actor.displayName}（{revision.actor.role}）· {new Date(revision.occurredAt).toLocaleString("zh-CN")}</span>
        {revision.before && <ul>{diffSnapshots(revision.before.sections, revision.after.sections).map((change) => <li key={change.key}>
          <b>{change.label}</b><span>前：{change.before || "（空）"}</span><span>后：{change.after || "（空）"}</span>
        </li>)}</ul>}
      </article>)}
    </details>
    <footer className="draft-review-actions">
      <span>临床批准：未执行</span>
      <div>
        <button type="button" disabled={busy || changeCount === 0} onClick={() => void submit("save")}>保存修改 {changeCount ? `(${changeCount})` : ""}</button>
        <button type="button" disabled={busy} onClick={() => void submit("needs-follow-up")}>需补充问诊</button>
        <button type="button" disabled={busy} onClick={() => void submit("reject")}>退回草稿</button>
        <button type="button" className="draft-demo-approve" disabled={busy} onClick={() => void submit("approve-demo")}>标记演示审核完成</button>
      </div>
    </footer>
  </section>;
}

function workflowLabel(status: string): string {
  switch (status) {
    case "needs-follow-up": return "需补充问诊";
    case "rejected-in-demo": return "演示中已退回";
    case "approved-in-demo": return "演示审核完成";
    default: return "初步草稿 · 待审核";
  }
}

function dispositionLabel(disposition: DraftItemDisposition): string {
  switch (disposition) {
    case "confirmed-in-demo": return "演示确认";
    case "rejected-in-demo": return "演示退回核实";
    default: return "未审核";
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case "turn-completed": return "完成咨询后生成/更新初稿";
    case "needs-follow-up": return "标记需补充问诊";
    case "reject": return "演示退回草稿";
    case "approve-demo": return "演示审核完成（非临床批准）";
    default: return "保存审核更改";
  }
}

function diffSnapshots(
  before: Readonly<Record<ClinicalDraftSection, readonly { itemId: string; label: string; value: string; disposition: DraftItemDisposition }[]>>,
  after: Readonly<Record<ClinicalDraftSection, readonly { itemId: string; label: string; value: string; disposition: DraftItemDisposition }[]>>,
): Array<{ key: string; label: string; before: string; after: string }> {
  const previous = new Map<string, { label: string; value: string; disposition: string }>();
  const next = new Map<string, { label: string; value: string; disposition: string }>();
  for (const [section, items] of Object.entries(before)) for (const item of items) previous.set(`${section}\0${item.itemId}`, item);
  for (const [section, items] of Object.entries(after)) for (const item of items) next.set(`${section}\0${item.itemId}`, item);
  const keys = new Set([...previous.keys(), ...next.keys()]);
  return [...keys].flatMap((key) => {
    const left = previous.get(key);
    const right = next.get(key);
    if (left?.value === right?.value && left?.disposition === right?.disposition) return [];
    const item = right ?? left;
    if (!item) return [];
    return [{ key, label: item.label, before: left ? `${left.value} · ${left.disposition}` : "", after: right ? `${right.value} · ${right.disposition}` : "" }];
  });
}
