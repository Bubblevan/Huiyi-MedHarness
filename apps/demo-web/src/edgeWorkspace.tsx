import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { EvidenceActionProvider, EvidenceDrawer, PatientContext, type EvidenceRecord } from "./components.js";
import { clinicalCopy } from "@clinical-workstation-copy";
import { Consultation } from "./consultation.js";
import type { WireDemoEvent } from "./runtime/adapter.js";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";

const API_BASE = import.meta.env.HUIYI_DEMO_API_BASE || "/api";

interface AccountView { displayName: string; role: string }
interface EncounterOption { encounterId: string; label: string; status: "finished" | "in-progress" }
interface PatientOption { patientId: string; displayName: string; age: number; sex: string; synthetic: true; encounters: EncounterOption[] }

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP_${response.status}`);
  return value;
}

export function EdgeWorkspace() {
  const [serviceReady, setServiceReady] = useState<boolean | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string>();
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const activeRunRef = useRef<{ runId: string; sessionId: string } | null>(null);
  const accountRef = useRef<AccountView | null>(null);

  const loadAuthorizedPatients = useCallback(async (value: AccountView) => {
    accountRef.current = value;
    setAccount(value);
    const response = await readJson<{ patients: PatientOption[] }>(await fetch(`${API_BASE}/patients`, { credentials: "same-origin" }));
    setPatients(response.patients);
    const first = response.patients[0];
    setPatientId(first?.patientId ?? "");
    setEncounterId(first?.encounters.at(-1)?.encounterId ?? "");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/health`, { credentials: "same-origin", signal: controller.signal })
      .then((response) => response.ok ? readJson<{ backendReady?: boolean }>(response) : undefined)
      .then((result) => { if (!controller.signal.aborted) setServiceReady(Boolean(result?.backendReady)); })
      .catch(() => { if (!controller.signal.aborted) setServiceReady(false); });
    fetch(`${API_BASE}/auth/session`, { credentials: "same-origin", signal: controller.signal })
      .then((response) => response.ok ? readJson<{ user: AccountView }>(response) : undefined)
      .then((result) => { if (result && !controller.signal.aborted) void loadAuthorizedPatients(result.user); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [loadAuthorizedPatients]);

  const closeBoundSession = useCallback(async (closingSessionId: string) => {
    const active = activeRunRef.current;
    if (active?.sessionId === closingSessionId) {
      await fetch(`${API_BASE}/runs/${encodeURIComponent(active.runId)}/cancel`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}",
      });
      activeRunRef.current = null;
    }
    const response = await fetch(`${API_BASE}/sessions/${encodeURIComponent(closingSessionId)}`, {
      method: "DELETE", credentials: "same-origin",
    });
    if (!response.ok && response.status !== 404) throw new Error(response.status === 409 ? "SESSION_BUSY" : "SESSION_CLOSE_FAILED");
    if (sessionRef.current === closingSessionId) sessionRef.current = null;
  }, []);

  const refreshSelection = useCallback(async (selectedPatientId: string, selectedEncounterId: string) => {
    if (!accountRef.current || !selectedPatientId || !selectedEncounterId) return;
    setBusy(true);
    setErrorCode(undefined);
    try {
      if (sessionRef.current) await closeBoundSession(sessionRef.current);
      setPatient(null);
      setSessionId(null);
      setEvidence([]);
      const context = await readJson<PatientRecord>(await fetch(
        `${API_BASE}/patients/${encodeURIComponent(selectedPatientId)}/context?encounterId=${encodeURIComponent(selectedEncounterId)}`,
        { credentials: "same-origin" },
      ));
      const session = await readJson<{ sessionId: string }>(await fetch(`${API_BASE}/sessions`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId: selectedPatientId, encounterId: selectedEncounterId }),
      }));
      sessionRef.current = session.sessionId;
      setPatient(context);
      setSessionId(session.sessionId);
    } catch (error) {
      setPatient(null);
      setSessionId(null);
      setErrorCode(error instanceof Error ? error.message : "PATIENT_CONTEXT_UNAVAILABLE");
    } finally { setBusy(false); }
  }, [closeBoundSession]);

  useEffect(() => {
    if (!account || !patientId || !encounterId) return;
    void refreshSelection(patientId, encounterId);
  }, [account, patientId, encounterId, refreshSelection]);

  const onEvent = useCallback((event: WireDemoEvent) => {
    if (event.event === "run.started") {
      activeRunRef.current = { runId: event.runId, sessionId: event.sessionId };
      setErrorCode(undefined);
    }
    if (["run.completed", "run.cancelled", "run.failed"].includes(event.event) && activeRunRef.current?.runId === event.runId) activeRunRef.current = null;
    if (event.event === "evidence.item" && typeof event.data.evidenceId === "string") {
      setEvidence((previous) => previous.some((item) => item.evidenceId === event.data.evidenceId)
        ? previous : [...previous, event.data as unknown as EvidenceRecord]);
    }
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      const result = await readJson<{ user: AccountView }>(await fetch(`${API_BASE}/auth/login`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      }));
      setPassword("");
      await loadAuthorizedPatients(result.user);
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_CREDENTIALS";
      setLoginError(code === "LOGIN_RATE_LIMITED" ? "登录尝试过多，请稍后再试。" : code === "ORIGIN_NOT_ALLOWED" ? "当前访问入口未获允许，请使用安全接入地址。" : "账号或密码无效。请联系管理员确认授权。 ");
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try {
      if (sessionRef.current) {
        try { await closeBoundSession(sessionRef.current); }
        catch (error) {
          const outcome = error instanceof Error && error.message === "SESSION_BUSY" ? "session_busy" : "session_close_failed";
          console.warn("[huiyi:trace] session.close.before_logout", { outcome });
          // Logout must still revoke the account and cancel any remaining run.
        }
      }
      await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      accountRef.current = null;
      setAccount(null); setPatients([]); setPatientId(""); setEncounterId(""); setPatient(null); setSessionId(null);
      setEvidence([]); setEvidenceOpen(false); setErrorCode(undefined); setBusy(false);
    }
  }

  const activePatient = patients.find((item) => item.patientId === patientId);
  const encounterOptions = activePatient?.encounters ?? [];
  const openEvidence = useCallback((id: string) => { setSelectedEvidence(id); setEvidenceOpen(true); }, []);

  if (serviceReady === false) return <main className="edge-unavailable" role="status">
    <img src="/huiyi-logo.png" alt="恩施慧宜眼科医院" />
    <h1>安全接入暂不可用</h1>
    <p>请通过医院提供的安全接入方式访问，或联系管理员检查本地服务连接。</p>
    <p>患者信息不会通过当前连接发送。</p>
  </main>;

  if (!account) return <main className="edge-login-area">
    <form className="edge-login-card" onSubmit={submitLogin}>
      <img src="/huiyi-logo.png" alt="恩施慧宜眼科医院" />
      <p className="edge-eyebrow">临床工作台</p>
      <h1>医护人员登录</h1>
      <p className="edge-login-note">请使用已授权的工作账号。登录后仅可查看授权范围内的模拟病例。</p>
      <label>工作账号<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={64} /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={256} /></label>
      {loginError && <p className="edge-login-error" role="alert">{loginError}</p>}
      <button type="submit" disabled={busy || serviceReady === null}>{busy ? "正在验证…" : "登录工作台"}</button>
      <p className="edge-synthetic-note">当前接入仅用于模拟病例体验，不含真实患者数据。</p>
    </form>
  </main>;

  return <EvidenceActionProvider onOpen={openEvidence}>
    <div className="workstation-shell edge-workstation">
      <header className="topbar edge-topbar">
        <a className="brand" href="#home" aria-label="恩施慧宜眼科医院"><img className="brand-logo" src="/huiyi-logo.png" alt="恩施慧宜眼科医院" /></a>
        <div className="topbar-context"><span className="product-name">慧宜临床辅助工作台</span></div>
        <div className="topbar-actions"><span className="account-label">{account.displayName}</span><button className="new-session-button" disabled={busy || !patientId} onClick={() => void refreshSelection(patientId, encounterId)}>新建接诊</button><button className="new-session-button" disabled={busy} onClick={() => void logout()}>退出登录</button></div>
      </header>
      <div className="edge-case-toolbar">
        <span className="synthetic-tag">模拟病例</span>
        <label>患者<select aria-label="患者" value={patientId} onChange={(event) => {
          const next = patients.find((item) => item.patientId === event.target.value);
          setPatientId(event.target.value);
          setEncounterId(next?.encounters.at(-1)?.encounterId ?? "");
        }}>
          {patients.map((item) => <option value={item.patientId} key={item.patientId}>{item.displayName} · {item.age} 岁 · {item.sex}</option>)}
        </select></label>
        <label>就诊记录<select aria-label="就诊记录" value={encounterId} onChange={(event) => setEncounterId(event.target.value)}>
          {encounterOptions.map((item) => <option value={item.encounterId} key={item.encounterId}>{item.label}</option>)}
        </select></label>
      </div>
      <main className="workstation-grid edge-grid">
        <aside className="side-column patient-column"><PatientContext patient={patient} loading={busy && !patient} syntheticLabel="模拟患者" /></aside>
        <section className="consultation-column">
          <Consultation key={sessionId ?? "no-session"} patientId={patient?.patientId ?? ""} encounterId={encounterId} sessionId={sessionId ?? ""} scenario="simple" includeScenario={false} showInternalMetadata={false} canSubmit={Boolean(serviceReady && patient && sessionId && !busy)} onEvent={onEvent} onError={setErrorCode} onRetry={() => void refreshSelection(patientId, encounterId)} onChooseScenario={() => undefined} errorCode={errorCode} />
        </section>
      </main>
      <footer className="edge-footer">
        <p>{clinicalCopy.disclaimer}</p>
        <p>本工作台当前仅提供模拟病例体验。</p>
      </footer>
      <EvidenceDrawer open={evidenceOpen} items={evidence} onClose={() => setEvidenceOpen(false)} backend="dsh" />
      {selectedEvidence && evidenceOpen && <span className="sr-only" aria-live="polite">已打开证据 {selectedEvidence}</span>}
    </div>
  </EvidenceActionProvider>;
}
