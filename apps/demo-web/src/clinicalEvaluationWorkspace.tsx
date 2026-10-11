import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AgentActivity, BackendBadge, EvidenceActionProvider, EvidenceDrawer, PatientContext, toSafeActivityEvent, type EvidenceRecord } from "./components.js";
import { applicationVersion, environmentLabel, runtimeConfig } from "./config/env.js";
import { clinicalCopy } from "@clinical-workstation-copy";
import type { WireDemoEvent } from "./runtime/adapter.js";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import { Consultation } from "./consultation.js";

const API_BASE = import.meta.env.HUIYI_DEMO_API_BASE || "/api";

interface AccountView { displayName: string; role: string; environment: string }
interface EncounterOption { encounterId: string; label: string; status: "finished" | "in-progress" }
interface PatientOption { patientId: string; displayName: string; age: number; sex: string; synthetic: true; encounters: EncounterOption[] }

async function decodeJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload;
}

export function ClinicalEvaluationWorkspace() {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [backend, setBackend] = useState("unavailable");
  const [providerName, setProviderName] = useState(runtimeConfig.providerName ?? "");
  const [modelName, setModelName] = useState(runtimeConfig.modelName ?? "");
  const [events, setEvents] = useState<WireDemoEvent[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/health`, { signal: controller.signal }).then((response) => decodeJson<{ backend?: string; providerName?: string; modelName?: string }>(response))
      .then((value) => {
        setBackend(value.backend === "dsh" ? "dsh" : "unavailable");
        setProviderName(runtimeConfig.providerName ?? value.providerName ?? "");
        setModelName(runtimeConfig.modelName ?? value.modelName ?? "");
      }).catch(() => undefined);
    fetch(`${API_BASE}/auth/session`, { credentials: "same-origin", signal: controller.signal })
      .then((response) => response.ok ? decodeJson<{ user: AccountView }>(response) : undefined)
      .then((value) => { if (value) void acceptAccount(value.user); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const acceptAccount = useCallback(async (value: AccountView) => {
    setAccount(value);
    const result = await decodeJson<{ patients: PatientOption[] }>(await fetch(`${API_BASE}/patients`, { credentials: "same-origin" }));
    setPatients(result.patients);
    const firstPatient = result.patients[0];
    if (!firstPatient) {
      setPatientId("");
      setEncounterId("");
      setPatient(null);
      setSessionId(null);
      return;
    }
    const currentEncounter = firstPatient.encounters.at(-1);
    setPatientId(firstPatient.patientId);
    setEncounterId(currentEncounter?.encounterId ?? "");
  }, []);

  const activePatient = patients.find((item) => item.patientId === patientId);
  const encounterOptions = activePatient?.encounters ?? [];

  const refreshSelection = useCallback(async (selectedPatientId: string, selectedEncounterId: string, signal?: AbortSignal) => {
    if (!selectedPatientId || !selectedEncounterId || !account) return;
    setPatient(null);
    setSessionId(null);
    setEvents([]);
    setEvidence([]);
    setErrorCode(undefined);
    try {
      const [contextResponse, sessionResponse] = await Promise.all([
        fetch(`${API_BASE}/patients/${encodeURIComponent(selectedPatientId)}/context?encounterId=${encodeURIComponent(selectedEncounterId)}`, { credentials: "same-origin", signal }),
        fetch(`${API_BASE}/sessions`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patientId: selectedPatientId, encounterId: selectedEncounterId }),
          signal,
        }),
      ]);
      const context = await decodeJson<PatientRecord>(contextResponse);
      const session = await decodeJson<{ sessionId: string }>(sessionResponse);
      if (signal?.aborted) return;
      setPatient(context);
      setSessionId(session.sessionId);
    } catch (error) {
      if (signal?.aborted) return;
      setPatient(null);
      setSessionId(null);
      setErrorCode(error instanceof Error ? error.message : "PATIENT_CONTEXT_UNAVAILABLE");
    }
  }, [account]);

  useEffect(() => {
    if (!account || !patientId || !encounterId) return;
    const controller = new AbortController();
    void refreshSelection(patientId, encounterId, controller.signal);
    return () => controller.abort();
  }, [account, patientId, encounterId, refreshSelection]);

  const onEvent = useCallback((event: WireDemoEvent) => {
    const safeEvent = toSafeActivityEvent(event);
    if (safeEvent) setEvents((previous) => [...previous, safeEvent]);
    if (event.event === "run.started") setErrorCode(undefined);
    if (event.event === "evidence.item" && typeof event.data.evidenceId === "string") {
      setEvidence((previous) => previous.some((item) => item.evidenceId === event.data.evidenceId)
        ? previous
        : [...previous, event.data as unknown as EvidenceRecord]);
    }
  }, []);

  const onError = useCallback((code: string) => setErrorCode(code), []);
  const provider = useMemo(() => <EvidenceActionProvider onOpen={(id) => { setSelectedEvidence(id); setEvidenceOpen(true); }}>
    <div className="workstation-shell clinical-evaluation-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="恩施慧宜眼科医院"><img className="brand-logo" src="/huiyi-logo.png" alt="恩施慧宜眼科医院" /></a>
        <div className="topbar-context"><span className="product-name">临床工作台</span><span className="environment-badge">{environmentLabel}</span></div>
        <div className="topbar-actions"><BackendBadge backend={backend} providerName={providerName} modelName={modelName} />{account && <><span className="account-label">{account.displayName}</span><button className="new-session-button" onClick={() => void refreshSelection(patientId, encounterId)}>新建会话 <span>＋</span></button><button className="new-session-button" onClick={() => void logout()}>退出登录</button></>}</div>
      </header>
      {!account ? <main className="evaluation-login-area"><form className="evaluation-login-card" onSubmit={submitLogin}>
        <p className="eyebrow">CLINICAL WORKSPACE</p><h1>登录临床工作台</h1>
        <p className="evaluation-note">使用临床评测账号访问授权范围内的模拟患者与就诊记录。</p>
        <label>评测账号<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={64} /></label>
        <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={256} /></label>
        {loginError && <p className="login-error" role="alert">{loginError}</p>}
        <button className="send-button evaluation-login-button" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
        <p className="evaluation-synthetic-label">所有患者与病程均为模拟数据</p>
      </form></main> : <>
        <div className="evaluation-toolbar">
          <label>患者<select value={patientId} onChange={(event) => {
            const next = patients.find((item) => item.patientId === event.target.value);
            setPatientId(event.target.value);
            setEncounterId(next?.encounters.at(-1)?.encounterId ?? "");
          }}>
            {patients.map((item) => <option value={item.patientId} key={item.patientId}>{item.displayName} · {item.age} 岁 · {item.sex}</option>)}
          </select></label>
          <label>就诊记录<select value={encounterId} onChange={(event) => setEncounterId(event.target.value)}>
            {encounterOptions.map((item) => <option value={item.encounterId} key={item.encounterId}>{item.label}</option>)}
          </select></label>
          <span className="synthetic-tag">模拟患者</span>
        </div>
        <main className="workstation-grid">
          <aside className="side-column patient-column"><PatientContext patient={patient} loading={Boolean(patientId && !patient && !errorCode)} syntheticLabel="模拟患者" /></aside>
          <section className="consultation-column">
            <Consultation key={sessionId ?? "pending"} patientId={patient?.patientId ?? ""} encounterId={encounterId} sessionId={sessionId ?? ""} scenario="simple" includeScenario={false} canSubmit={Boolean(patient && sessionId && backend === "dsh")} onEvent={onEvent} onError={onError} onRetry={() => void refreshSelection(patientId, encounterId)} onChooseScenario={() => undefined} errorCode={errorCode} />
          </section>
          <aside className="side-column activity-column"><AgentActivity events={events} errorCode={errorCode} /></aside>
        </main>
        <footer className="global-footer">
          <div className="footer-runtime"><strong>Huiyi MedHarness · v{applicationVersion}</strong><span>{environmentLabel}</span><span>{providerName && modelName ? `${providerName} · ${modelName}` : "模型信息暂不可用"}</span></div>
          <address className="organization-details">
            <span>主办单位 · <a href="http://www.huiyi9e.com/" title="湖北慧宜医疗管理集团有限公司" target="_blank" rel="noreferrer"><strong>湖北慧宜医疗管理集团有限公司</strong></a></span>
            <span>承办单位 · <a href="http://yk.huiyi9e.com/" title="恩施慧宜眼科医院有限责任公司" target="_blank" rel="noreferrer"><strong>恩施慧宜眼科医院有限责任公司</strong></a></span>
            <span>通信地址 · 湖北省恩施市金龙大道青树林区一号路</span>
            <span>办公电话 · <a href="tel:0718-8259000"><strong>0718-8259000</strong></a></span>
          </address>
          <div className="footer-actions"><span>仅显示脱敏执行元数据</span></div>
        </footer>
      </>}
      <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} backend="dsh" />
      {selectedEvidence && evidenceOpen && <span className="sr-only" aria-live="polite">已打开证据 {selectedEvidence}</span>}
    </div>
  </EvidenceActionProvider>, [account, backend, encounterId, encounterOptions, environmentLabel, errorCode, evidence, evidenceOpen, events, loginError, modelName, patient, patientId, patients, providerName, refreshSelection, selectedEvidence, sessionId, busy, username, password]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      const result = await decodeJson<{ user: AccountView }>(await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      }));
      setPassword("");
      await acceptAccount(result.user);
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_CREDENTIALS";
      setLoginError(code === "LOGIN_RATE_LIMITED" ? "登录尝试过多，请稍后重试。" : "账号或密码无效。");
    } finally { setBusy(false); }
  }

  async function logout() {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    setAccount(null); setPatients([]); setPatientId(""); setEncounterId(""); setPatient(null); setSessionId(null); setEvents([]); setEvidence([]); setErrorCode(undefined);
  }

  return provider;
}
