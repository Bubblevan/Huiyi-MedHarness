const SCRIPT = String.raw`(() => {
  let packet = JSON.parse(document.getElementById("packet-data").textContent || "{}");
  const original = JSON.parse(JSON.stringify(packet));
  const root = document.getElementById("cases");
  const status = document.getElementById("status");
  const reviewerId = document.getElementById("reviewer-id");
  const clinicianAck = document.getElementById("clinician-ack");
  const checks = [
    ["profileFactConsistency", "档案与事实一致"],
    ["medicationAllergySafety", "用药与过敏信息表达安全"],
    ["riskSignalCoverage", "风险信号覆盖与表述恰当"],
    ["disclosurePlanCoherence", "问诊披露方案连贯且不泄露未披露事实"]
  ];
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value == null ? "" : String(value);
    if (className) node.className = className;
    return node;
  };
  const stable = (value) => Array.isArray(value)
    ? "[" + value.map(stable).join(",") + "]"
    : value && typeof value === "object"
      ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
      : JSON.stringify(value);
  const immutable = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.reviewer;
    copy.cases.forEach((item) => { delete item.review; });
    return stable(copy);
  };
  const setReview = (item, field, value) => { item.review[field] = value || "pending"; updateStatus(); };
  const select = (item, field, label, choices) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.append(text("span", label));
    const control = document.createElement("select");
    control.setAttribute("aria-label", label);
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "请选择";
    control.append(empty);
    choices.forEach(([value, title]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = title;
      control.append(option);
    });
    control.value = item.review[field] === "pending" ? "" : item.review[field] || "";
    control.addEventListener("change", () => setReview(item, field, control.value));
    wrap.append(control);
    return wrap;
  };
  const appendList = (parent, values, format) => {
    const list = document.createElement("ul");
    (values || []).forEach((value) => list.append(text("li", format ? format(value) : value)));
    if (!values || !values.length) list.append(text("li", "无"));
    parent.append(list);
  };
  const renderTurn = (turn) => {
    const details = document.createElement("details");
    details.className = "turn";
    const summary = text("summary", turn.turnId + " · " + turn.encounterId);
    details.append(summary);
    details.append(text("p", "模拟患者信息：" + turn.patientMessage));
    details.append(text("p", "预期工作项：" + (turn.expectedTaskIds || []).join("、")));
    details.append(text("p", "需关注历史事实：" + ((turn.requiredHistoricalFactIds || []).join("、") || "无")));
    details.append(text("p", "需关注本次事实：" + ((turn.requiredCurrentFactIds || []).join("、") || "无")));
    details.append(text("p", "预期风险信号：" + ((turn.expectedRiskSignalIds || []).join("、") || "无")));
    if (turn.patientPlan) {
      details.append(text("p", "开场：" + turn.patientPlan.openingMessage));
      details.append(text("p", "初始披露事实：" + ((turn.patientPlan.initialFactIds || []).join("、") || "无")));
      details.append(text("h4", "追问后允许披露"));
      appendList(details, turn.patientPlan.disclosures, (entry) => (entry.triggers || []).join("、") + " → " + (entry.factIds || []).join("、"));
    }
    return details;
  };
  const renderCase = (item, index) => {
    const details = document.createElement("details");
    details.className = "case";
    if (index === 0) details.open = true;
    const summary = text("summary", item.reviewCaseId + " · " + item.profile.syntheticLabel + " · " + item.complexity);
    details.append(summary);
    details.append(text("p", "合成档案：" + item.profile.age + " 岁 · " + item.profile.gender + " · 场景族 " + item.scenarioFamily));
    if (item.caseDesign) {
      const design = item.caseDesign;
      details.append(text("p", "设计维度：难度 " + design.difficultyTier + " · 领域 " + design.domain + " · 轨迹 " + design.trajectory
        + " · 历史依赖 " + design.historyDependency + " · 资料缺口 " + design.informationGap + " · 冲突 " + design.conflictType
        + " · 风险 " + design.riskEvent + " · " + design.encounterCount + " 次就诊"));
    }
    details.append(text("h3", "事实与 Encounter 来源"));
    appendList(details, item.facts, (fact) => "[" + fact.factId + " · " + fact.encounterId + " · " + fact.category + "] " + fact.label + "：" + fact.value);
    details.append(text("h3", "问诊与披露计划"));
    (item.turns || []).forEach((turn) => details.append(renderTurn(turn)));
    details.append(text("h3", "临床内容审核"));
    const form = document.createElement("div");
    form.className = "review-grid";
    checks.forEach(([field, label]) => form.append(select(item, field, label, [["pass", "通过"], ["fail", "不通过"]])));
    form.append(select(item, "decision", "病例结论", [["approve-for-engineering", "通过工程评测数据门槛"], ["revise", "退回修订"]]));
    details.append(form);
    const notes = document.createElement("label");
    notes.className = "field notes";
    notes.append(text("span", "修订意见（退回修订时必填）"));
    const area = document.createElement("textarea");
    area.rows = 4;
    area.value = item.review.correctionNotes || "";
    area.addEventListener("input", () => setReview(item, "correctionNotes", area.value));
    notes.append(area);
    details.append(notes);
    return details;
  };
  const updateStatus = () => {
    const complete = packet.cases.filter((item) => checks.every(([field]) => item.review[field] === "pass" || item.review[field] === "fail")
      && (item.review.decision === "approve-for-engineering" || item.review.decision === "revise")
      && (item.review.decision !== "revise" || Boolean(item.review.correctionNotes.trim()))).length;
    status.textContent = complete + " / " + packet.cases.length + " 例审核表已完整填写。只有全部病例完成后才能导入审批；审批仅解锁工程评测，不表示临床有效。";
  };
  const validate = () => {
    const errors = [];
    if (!reviewerId.value.trim()) errors.push("请填写审核者编号或机构审核 ID。");
    if (!clinicianAck.checked) errors.push("请确认当前审核者具备持证临床审核资格。");
    packet.cases.forEach((item) => {
      checks.forEach(([field, label]) => {
        if (item.review[field] !== "pass" && item.review[field] !== "fail") errors.push(item.reviewCaseId + "：" + label + "尚未完成。");
      });
      if (item.review.decision !== "approve-for-engineering" && item.review.decision !== "revise") errors.push(item.reviewCaseId + "：尚未选择病例结论。");
      if (item.review.decision === "approve-for-engineering" && checks.some(([field]) => item.review[field] !== "pass")) errors.push(item.reviewCaseId + "：有审核项不通过，不能批准用于工程评测。");
      if (item.review.decision === "revise" && !item.review.correctionNotes.trim()) errors.push(item.reviewCaseId + "：退回修订必须填写理由。");
    });
    return errors;
  };
  const download = (complete) => {
    if (complete) {
      const errors = validate();
      if (errors.length) {
        status.textContent = errors.slice(0, 8).join(" ") + (errors.length > 8 ? " 另有 " + (errors.length - 8) + " 项未完成。" : "");
        status.focus();
        return;
      }
      packet.reviewer = { reviewerId: reviewerId.value.trim(), reviewerRole: "licensed-clinician", reviewedAt: new Date().toISOString() };
    } else {
      packet.reviewer = { reviewerId: reviewerId.value.trim() || null, reviewerRole: clinicianAck.checked ? "licensed-clinician" : null, reviewedAt: null };
    }
    const blob = new Blob([JSON.stringify(packet, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = complete ? "reviewed-cohort-packet.json" : "cohort-review-progress.json";
    link.click();
    URL.revokeObjectURL(url);
    status.textContent = complete ? "评审包已导出。请将 JSON 和机构审核记录一并交给评测负责人；不要发送 private crosswalk。" : "进度已导出；重新打开工作台后可加载此 JSON 继续。";
  };
  document.getElementById("save-progress").addEventListener("click", () => download(false));
  document.getElementById("export-final").addEventListener("click", () => download(true));
  document.getElementById("load-file").addEventListener("click", () => document.getElementById("file-input").click());
  document.getElementById("file-input").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (immutable(imported) !== immutable(original) || imported.cohortSha256 !== original.cohortSha256) throw new Error("文件病例内容、顺序或 cohort hash 与本工作台不一致。");
      packet = imported;
      reviewerId.value = packet.reviewer.reviewerId || "";
      clinicianAck.checked = packet.reviewer.reviewerRole === "licensed-clinician";
      root.replaceChildren();
      packet.cases.forEach((item, index) => root.append(renderCase(item, index)));
      status.textContent = "已载入同一病例清单的评审进度。";
      updateStatus();
    } catch (error) {
      status.textContent = "无法载入：" + (error instanceof Error ? error.message : "无效 JSON");
    } finally {
      event.target.value = "";
    }
  });
  reviewerId.addEventListener("input", updateStatus);
  clinicianAck.addEventListener("change", updateStatus);
  packet.cases.forEach((item, index) => root.append(renderCase(item, index)));
  document.getElementById("cohort-hash").textContent = packet.cohortSha256;
  document.getElementById("case-count").textContent = String(packet.cases.length);
  document.getElementById("instructions").replaceChildren(...packet.instructions.map((line) => text("li", line)));
  updateStatus();
})();`;

export function renderReviewWorkbenchHtml(input: unknown): string {
  if (!isRecord(input) || input.schemaVersion !== "huiyi-synthetic-cohort-review/v1"
    || input.requiredReviewerRole !== "licensed-clinician" || !/^[a-f0-9]{64}$/.test(String(input.cohortSha256 ?? ""))
    || !Array.isArray(input.instructions) || !Array.isArray(input.cases) || input.cases.length === 0) {
    throw new TypeError("input is not a licensed-clinician synthetic cohort review packet");
  }
  for (const item of input.cases) {
    if (!isRecord(item) || typeof item.reviewCaseId !== "string" || !isRecord(item.profile)
      || !Array.isArray(item.facts) || !Array.isArray(item.turns) || !isRecord(item.review)) {
      throw new TypeError("review packet contains a malformed case");
    }
  }
  const embedded = JSON.stringify(input)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>合成临床队列审核工作台</title>
<style>
:root{font-family:Segoe UI,"Microsoft YaHei",sans-serif;color:#17212b;background:#f3f6f8}*{box-sizing:border-box}body{margin:0}header{background:#123047;color:white;padding:24px max(20px,calc((100% - 1100px)/2))}h1{font-size:24px;margin:0 0 8px}header p{margin:4px 0;color:#d6e4ee}.shell{max-width:1100px;margin:22px auto;padding:0 16px}.notice{background:#fff7df;border:1px solid #e8d39a;padding:14px 16px;border-radius:8px;margin-bottom:16px}.toolbar,.panel,.case{background:white;border:1px solid #d8e0e6;border-radius:9px;padding:16px;margin:12px 0}.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1}button{border:0;border-radius:6px;background:#176b87;color:white;padding:10px 14px;font-weight:600;cursor:pointer}button.secondary{background:#52636d}button:focus,select:focus,textarea:focus,input:focus{outline:3px solid #80c6e0;outline-offset:1px}.field{display:grid;gap:5px;font-weight:600}.field select,.field textarea,.field input{font:inherit;padding:8px;border:1px solid #aebbc4;border-radius:5px;background:white}.ack{display:flex;gap:9px;align-items:flex-start}.hash{font-family:Consolas,monospace;overflow-wrap:anywhere;font-size:13px}.case>summary{font-size:18px;font-weight:700;cursor:pointer}.case h3{margin:20px 0 8px;border-bottom:1px solid #e4e9ed;padding-bottom:6px}.case h4{margin:12px 0 4px}.case ul{padding-left:22px}.case li{margin:5px 0;line-height:1.5}.turn{margin:8px 0 8px 12px;padding:9px 12px;background:#f7f9fa;border-radius:6px}.turn>summary{cursor:pointer;font-weight:600}.turn p{line-height:1.5}.review-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.notes{margin-top:12px}.status{position:sticky;bottom:8px;background:#e7f4f8;border:1px solid #a8d2df;padding:12px;border-radius:8px;box-shadow:0 2px 9px #142a3522}.muted{color:#4e5c64}@media(max-width:700px){.toolbar,.review-grid{grid-template-columns:1fr}.actions{grid-column:auto}}@media print{body{background:white}header{background:white;color:#17212b;padding:12px}.toolbar,.actions,.status,.notice{display:none}.shell{max-width:none;margin:0}.case{break-inside:avoid;border-color:#aaa}.case:not([open])>*:not(summary){display:block}}
</style>
</head>
<body>
<header><h1>合成临床队列审核工作台</h1><p>仅用于合成评测病例的数据质量与披露规则审核，不是临床诊断或真实患者记录。</p><p>病例数：<span id="case-count"></span> · 审核角色：持证临床专业人员</p></header>
<main class="shell">
<div class="notice"><strong>审核边界：</strong>请独立审核病例事实、药物/过敏表述、风险覆盖与披露顺序。批准只授权工程评测，不代表临床有效性。不要添加真实患者信息。此文件完全离线，不连接服务器；请勿把 private crosswalk 发给审核者。</div>
<section class="panel"><h2>审核说明</h2><ul id="instructions"></ul><p>固定 Cohort SHA-256：<span id="cohort-hash" class="hash"></span></p></section>
<section class="toolbar"><label class="field">审核者编号或机构审核 ID<input id="reviewer-id" maxlength="160" autocomplete="off"></label><label class="ack"><input id="clinician-ack" type="checkbox"><span>我确认本人符合本次所要求的持证临床审核角色。</span></label><div class="actions"><button id="load-file" class="secondary" type="button">载入已有审核进度</button><input id="file-input" type="file" accept="application/json,.json" hidden><button id="save-progress" class="secondary" type="button">导出进度</button><button id="export-final" type="button">校验并导出完成的评审包</button></div></section>
<div id="cases"></div><div id="status" class="status" role="status" tabindex="-1"></div>
</main>
<script id="packet-data" type="application/json">${embedded}</script><script>${SCRIPT}</script>
</body></html>\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
