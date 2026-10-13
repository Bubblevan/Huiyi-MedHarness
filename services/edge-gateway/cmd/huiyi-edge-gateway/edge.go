package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type patientEncounter struct {
	EncounterID string `json:"encounterId"`
	Label       string `json:"label"`
	Status      string `json:"status"`
}

type patientSummary struct {
	PatientID  string             `json:"patientId"`
	Display    string             `json:"displayName"`
	Age        int                `json:"age"`
	Sex        string             `json:"sex"`
	Synthetic  bool               `json:"synthetic"`
	Encounters []patientEncounter `json:"encounters"`
}

var patients = map[string]patientSummary{
	"patient-htn": {
		PatientID: "patient-htn", Display: "张某", Age: 52, Sex: "男", Synthetic: true,
		Encounters: []patientEncounter{{EncounterID: "demo-encounter-htn", Label: "高血压复诊 · 2026-10-09", Status: "finished"}},
	},
	"patient-complex": {
		PatientID: "patient-complex", Display: "李某", Age: 67, Sex: "女", Synthetic: true,
		Encounters: []patientEncounter{{EncounterID: "demo-encounter-complex", Label: "复杂病例讨论 · 2026-10-09", Status: "in-progress"}},
	},
}

type edgeServer struct {
	auth         *authState
	upstream     *url.URL
	origins      map[string]struct{}
	audit        *auditLog
	trace        *edgeTraceLog
	cookieSecure bool
	runsMu       sync.Mutex
	runs         map[string]runBinding
	transport    http.RoundTripper
}

type runBinding struct {
	AuthSession string
	Username    string
	PatientID   string
	SessionID   string
}

func newEdgeServer(accounts []accountConfig, upstream *url.URL, origins map[string]struct{}, audit *auditLog, cookieSecure bool, traces ...*edgeTraceLog) (*edgeServer, error) {
	auth, err := newAuthState(accounts)
	if err != nil {
		return nil, err
	}
	var trace *edgeTraceLog
	if len(traces) > 0 {
		trace = traces[0]
	}
	return &edgeServer{
		auth: auth, upstream: upstream, origins: origins, audit: audit,
		trace: trace, cookieSecure: cookieSecure, runs: map[string]runBinding{},
		transport: &http.Transport{DialContext: (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ResponseHeaderTimeout: 10 * time.Minute, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 20},
	}, nil
}

func (e *edgeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := randomToken(16)
	w.Header().Set("X-Request-ID", requestID)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/health":
		e.health(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/api/auth/login":
		e.login(w, r, requestID)
	case r.Method == http.MethodGet && r.URL.Path == "/api/auth/session":
		e.authSession(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/api/auth/logout":
		e.logout(w, r, requestID)
	case r.Method == http.MethodGet && r.URL.Path == "/api/patients":
		e.patientList(w, r, requestID)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/patients/") && strings.HasSuffix(r.URL.Path, "/context"):
		e.patientContext(w, r, requestID)
	case r.Method == http.MethodPost && r.URL.Path == "/api/sessions":
		e.createSession(w, r, requestID)
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/sessions/"):
		e.closeSession(w, r, requestID)
	case r.Method == http.MethodPost && r.URL.Path == "/api/chat":
		e.chat(w, r, requestID)
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/runs/") && strings.HasSuffix(r.URL.Path, "/cancel"):
		e.cancelRun(w, r, requestID)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
	}
}

func (e *edgeServer) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(e.upstream.String(), "/")+"/api/health", nil)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "backendReady": false})
		return
	}
	response, err := e.transport.RoundTrip(request)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "backendReady": false})
		return
	}
	_ = response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "backendReady": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "backendReady": true})
}

func (e *edgeServer) login(w http.ResponseWriter, r *http.Request, requestID string) {
	if !e.validMutation(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ORIGIN_NOT_ALLOWED"})
		return
	}
	if !isJSON(r) {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "UNSUPPORTED_MEDIA_TYPE"})
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeLimitedJSON(w, r, 4096, &body); err != nil {
		writeJSON(w, decodeStatus(err), map[string]string{"error": "INVALID_REQUEST"})
		return
	}
	if len(body.Username) > 64 || len(body.Password) < 1 || len(body.Password) > 256 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_REQUEST"})
		return
	}
	username := strings.ToLower(strings.TrimSpace(body.Username))
	rateKey := rateLimitKey(r, username)
	if e.isRateLimited(rateKey) {
		_ = e.record(requestID, username, "auth.login", "rate_limited", "", "", http.StatusTooManyRequests)
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "LOGIN_RATE_LIMITED"})
		return
	}
	token, pr, ok, limited := e.auth.login(username, body.Password, rateKey, time.Now())
	if !ok {
		status, outcome, code := http.StatusUnauthorized, "denied", "INVALID_CREDENTIALS"
		if limited {
			status, outcome, code = http.StatusTooManyRequests, "rate_limited", "LOGIN_RATE_LIMITED"
		}
		if err := e.record(requestID, username, "auth.login", outcome, "", "", status); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
			return
		}
		writeJSON(w, status, map[string]string{"error": code})
		return
	}
	if err := e.record(requestID, pr.Username, "auth.login", "allowed", "", "", http.StatusOK); err != nil {
		e.auth.mu.Lock()
		delete(e.auth.sessions, hashToken(token))
		e.auth.mu.Unlock()
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	w.Header().Set("Set-Cookie", cookieHeader(token, e.cookieSecure || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"))
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": userView(pr)})
}

func (e *edgeServer) authSession(w http.ResponseWriter, r *http.Request) {
	pr, ok := e.auth.resolve(r, time.Now())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "AUTH_REQUIRED"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": userView(pr), "expiresAt": pr.ExpiresAt.UTC().Format(time.RFC3339)})
}

func (e *edgeServer) logout(w http.ResponseWriter, r *http.Request, requestID string) {
	if !e.validMutation(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ORIGIN_NOT_ALLOWED"})
		return
	}
	pr, ok := e.auth.resolve(r, time.Now())
	secure := e.cookieSecure || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	if !ok {
		w.Header().Set("Set-Cookie", clearCookieHeader(secure))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	auditErr := e.record(requestID, pr.Username, "auth.logout", "allowed", "", "", http.StatusNoContent)
	_, _, _ = e.auth.revoke(r)
	for runID, binding := range e.activeRunsFor(pr.AuthSession) {
		go e.cancelUpstream(runID)
		deleteRun := runID
		e.runsMu.Lock()
		delete(e.runs, deleteRun)
		e.runsMu.Unlock()
		_ = binding
	}
	w.Header().Set("Set-Cookie", clearCookieHeader(secure))
	if auditErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (e *edgeServer) patientList(w http.ResponseWriter, r *http.Request, requestID string) {
	pr, ok := e.requirePrincipal(w, r)
	if !ok {
		_ = e.record(requestID, "", "patient.list", "unauthenticated", "", "", http.StatusUnauthorized)
		return
	}
	result := make([]patientSummary, 0, len(pr.PatientScope))
	for patientID := range pr.PatientScope {
		result = append(result, patients[patientID])
	}
	sort.Slice(result, func(i, j int) bool { return result[i].PatientID < result[j].PatientID })
	if err := e.record(requestID, pr.Username, "patient.list", "allowed", "", "", http.StatusOK); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"patients": result})
}

func (e *edgeServer) patientContext(w http.ResponseWriter, r *http.Request, requestID string) {
	pr, ok := e.requirePrincipal(w, r)
	if !ok {
		_ = e.record(requestID, "", "patient.context", "unauthenticated", "", "", http.StatusUnauthorized)
		return
	}
	patientID, err := patientIDFromContextPath(r.URL.Path)
	encounterID := r.URL.Query().Get("encounterId")
	item, known := patients[patientID]
	if err != nil || !known || !pr.PatientScope[patientID] {
		_ = e.record(requestID, pr.Username, "patient.context", "denied", patientID, encounterID, http.StatusNotFound)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "PATIENT_NOT_FOUND"})
		return
	}
	if !containsEncounter(item, encounterID) {
		_ = e.record(requestID, pr.Username, "patient.context", "denied", patientID, encounterID, http.StatusNotFound)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "PATIENT_OR_ENCOUNTER_NOT_FOUND"})
		return
	}
	if err := e.record(requestID, pr.Username, "patient.context", "allowed", patientID, encounterID, http.StatusOK); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	e.proxy(w, r, "/api/demo/patients/"+url.PathEscape(patientID), func(status int) {
		_ = e.record(requestID, pr.Username, "patient.context.result", httpOutcome(status), patientID, encounterID, status)
	})
}

func (e *edgeServer) createSession(w http.ResponseWriter, r *http.Request, requestID string) {
	if !e.validMutation(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ORIGIN_NOT_ALLOWED"})
		return
	}
	pr, ok := e.requirePrincipal(w, r)
	if !ok {
		_ = e.record(requestID, "", "session.create", "unauthenticated", "", "", http.StatusUnauthorized)
		return
	}
	if !isJSON(r) {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "UNSUPPORTED_MEDIA_TYPE"})
		return
	}
	var body struct {
		PatientID   string `json:"patientId"`
		EncounterID string `json:"encounterId"`
	}
	if err := decodeLimitedJSON(w, r, 4096, &body); err != nil {
		writeJSON(w, decodeStatus(err), map[string]string{"error": "INVALID_REQUEST"})
		return
	}
	if !safePatientID(body.PatientID) || !safeEncounterID(body.EncounterID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_REQUEST"})
		return
	}
	item, known := patients[body.PatientID]
	if !known || !pr.PatientScope[body.PatientID] || !containsEncounter(item, body.EncounterID) {
		_ = e.record(requestID, pr.Username, "session.create", "denied", body.PatientID, body.EncounterID, http.StatusNotFound)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "PATIENT_OR_ENCOUNTER_NOT_FOUND"})
		return
	}
	sessionID := randomToken(24)
	if err := e.record(requestID, pr.Username, "session.create", "allowed", body.PatientID, body.EncounterID, http.StatusCreated); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	e.auth.createBinding(pr, body.PatientID, body.EncounterID, sessionID)
	writeJSON(w, http.StatusCreated, map[string]any{"sessionId": sessionID, "patientId": body.PatientID, "encounterId": body.EncounterID, "expiresAt": pr.ExpiresAt.UTC().Format(time.RFC3339), "synthetic": true})
}

func (e *edgeServer) closeSession(w http.ResponseWriter, r *http.Request, requestID string) {
	if !e.validMutation(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ORIGIN_NOT_ALLOWED"})
		return
	}
	pr, ok := e.requirePrincipal(w, r)
	if !ok {
		_ = e.record(requestID, "", "session.close", "unauthenticated", "", "", http.StatusUnauthorized)
		return
	}
	sessionID := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	if sessionID == "" || strings.Contains(sessionID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_PATH"})
		return
	}
	binding, ok := e.auth.resolveBinding(pr, sessionID, time.Now())
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "SESSION_NOT_FOUND"})
		return
	}
	if e.hasRunForSession(sessionID) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "SESSION_BUSY"})
		return
	}
	if err := e.record(requestID, pr.Username, "session.close", "allowed", binding.PatientID, binding.EncounterID, http.StatusNoContent); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	_ = e.auth.closeBinding(pr, sessionID)
	w.WriteHeader(http.StatusNoContent)
}

func (e *edgeServer) chat(w http.ResponseWriter, r *http.Request, requestID string) {
	if !e.validMutation(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ORIGIN_NOT_ALLOWED"})
		return
	}
	pr, ok := e.requirePrincipal(w, r)
	if !ok {
		_ = e.record(requestID, "", "chat", "unauthenticated", "", "", http.StatusUnauthorized)
		return
	}
	if !isJSON(r) {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "UNSUPPORTED_MEDIA_TYPE"})
		return
	}
	var body struct {
		SessionID   string `json:"sessionId"`
		PatientID   string `json:"patientId"`
		EncounterID string `json:"encounterId"`
		Message     string `json:"message"`
	}
	if err := decodeLimitedJSON(w, r, 20_000, &body); err != nil {
		_ = e.record(requestID, pr.Username, "chat", "invalid_request", "", "", decodeStatus(err))
		writeJSON(w, decodeStatus(err), map[string]string{"error": "INVALID_REQUEST"})
		return
	}
	if body.SessionID == "" || len(body.SessionID) > 80 || !safePatientID(body.PatientID) || !safeEncounterID(body.EncounterID) || strings.TrimSpace(body.Message) == "" || len(body.Message) > 16_000 {
		_ = e.record(requestID, pr.Username, "chat", "invalid_request", "", "", http.StatusBadRequest)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_REQUEST"})
		return
	}
	binding, bound := e.auth.resolveBinding(pr, body.SessionID, time.Now())
	if !bound || binding.PatientID != body.PatientID || binding.EncounterID != body.EncounterID || !pr.PatientScope[body.PatientID] {
		_ = e.record(requestID, pr.Username, "chat", "denied", body.PatientID, body.EncounterID, http.StatusNotFound)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "SESSION_NOT_FOUND"})
		return
	}
	if err := e.record(requestID, pr.Username, "chat.start", "allowed", body.PatientID, body.EncounterID, http.StatusAccepted); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AUDIT_UNAVAILABLE"})
		return
	}
	started := time.Now()
	observer := newEdgeStreamObserver(e.trace, requestID, started, r.Context())
	observer.record("edge.chat.accepted", "allowed", http.StatusAccepted)
	r.Header.Set("X-Huiyi-Trace-ID", requestID)
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				observer.progress()
			case <-observer.done:
				return
			case <-r.Context().Done():
				observer.finish("client_disconnected", 0)
				return
			}
		}
	}()
	upstreamBody, _ := json.Marshal(map[string]string{"sessionId": body.SessionID, "patientId": body.PatientID, "message": body.Message})
	e.proxyWithBodyHooks(w, r, "/api/chat", upstreamBody, func(response *http.Response) {
		runID := response.Header.Get("X-Run-ID")
		observer.responseHeaders(runID, response.Header.Get("Content-Type"), response.StatusCode)
		if runID != "" && response.StatusCode >= 200 && response.StatusCode < 300 {
			e.runsMu.Lock()
			e.runs[runID] = runBinding{AuthSession: pr.AuthSession, Username: pr.Username, PatientID: body.PatientID, SessionID: body.SessionID}
			e.runsMu.Unlock()
		}
		auditedBody := &auditReadCloser{ReadCloser: response.Body, done: func(completed bool) {
			status := response.StatusCode
			outcome := httpOutcome(status)
			if status >= 200 && status < 300 && !completed {
				outcome = "interrupted"
			}
			_ = e.record(requestID, pr.Username, "chat.result", outcome, body.PatientID, body.EncounterID, status)
			if runID != "" {
				e.runsMu.Lock()
				delete(e.runs, runID)
				e.runsMu.Unlock()
			}
		}}
		response.Body = &tracedStreamBody{ReadCloser: auditedBody, observer: observer, status: response.StatusCode, ctx: r.Context()}
	}, func() {
		observer.finish("upstream_unavailable", http.StatusBadGateway)
		_ = e.record(requestID, pr.Username, "chat.result", "failed", body.PatientID, body.EncounterID, http.StatusBadGateway)
	})
}

func (e *edgeServer) cancelRun(w http.ResponseWriter, r *http.Request, requestID string) {
	if !e.validMutation(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ORIGIN_NOT_ALLOWED"})
		return
	}
	pr, ok := e.requirePrincipal(w, r)
	if !ok {
		_ = e.record(requestID, "", "run.cancel", "unauthenticated", "", "", http.StatusUnauthorized)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/runs/")
	if !strings.HasSuffix(path, "/cancel") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
		return
	}
	runID := strings.TrimSuffix(path, "/cancel")
	e.runsMu.Lock()
	binding, exists := e.runs[runID]
	e.runsMu.Unlock()
	if !exists || binding.AuthSession != pr.AuthSession || binding.Username != pr.Username {
		_ = e.record(requestID, pr.Username, "run.cancel", "denied", "", "", http.StatusNotFound)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "RUN_NOT_FOUND"})
		return
	}
	if !isJSON(r) {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "UNSUPPORTED_MEDIA_TYPE"})
		return
	}
	_ = e.record(requestID, pr.Username, "run.cancel", "allowed", binding.PatientID, "", http.StatusAccepted)
	e.proxy(w, r, "/api/runs/"+url.PathEscape(runID)+"/cancel", nil)
}

func (e *edgeServer) proxy(w http.ResponseWriter, r *http.Request, path string, modify func(int)) {
	e.proxyWithBody(w, r, path, nil, func(response *http.Response) {
		if modify != nil {
			modify(response.StatusCode)
		}
	})
}

func (e *edgeServer) proxyWithBody(w http.ResponseWriter, r *http.Request, path string, body []byte, modify func(*http.Response)) {
	e.proxyWithBodyHooks(w, r, path, body, modify, nil)
}

func (e *edgeServer) proxyWithBodyHooks(w http.ResponseWriter, r *http.Request, path string, body []byte, modify func(*http.Response), onError func()) {
	proxy := &httputil.ReverseProxy{
		Transport: e.transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(e.upstream)
			request.Out.URL.Path = path
			request.Out.URL.RawPath = ""
			request.Out.URL.RawQuery = ""
			request.Out.Host = e.upstream.Host
			request.Out.Header.Del("Cookie")
			request.Out.Header.Del("Authorization")
			request.Out.Header.Del("Origin")
			request.Out.Header.Del("X-Forwarded-For")
			request.Out.Header.Del("X-Forwarded-Host")
			request.Out.Header.Del("X-Forwarded-Proto")
			traceID := request.In.Header.Get("X-Huiyi-Trace-ID")
			if safeTraceIdentifier(traceID) {
				request.Out.Header.Set("X-Huiyi-Trace-ID", traceID)
			} else {
				request.Out.Header.Del("X-Huiyi-Trace-ID")
			}
			if body != nil {
				request.Out.Body = io.NopCloser(bytes.NewReader(body))
				request.Out.ContentLength = int64(len(body))
				request.Out.Header.Set("Content-Length", strconv.Itoa(len(body)))
				request.Out.Header.Set("Content-Type", "application/json")
			}
		},
		ModifyResponse: func(response *http.Response) error {
			if modify != nil {
				modify(response)
			}
			return nil
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			if onError != nil {
				onError()
			}
			writeJSON(response, http.StatusBadGateway, map[string]string{"error": "BACKEND_UNAVAILABLE"})
		},
	}
	proxy.ServeHTTP(w, r)
}

type auditReadCloser struct {
	io.ReadCloser
	once     sync.Once
	done     func(bool)
	complete bool
}

func (r *auditReadCloser) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if errors.Is(err, io.EOF) {
		r.complete = true
		r.once.Do(func() { r.done(true) })
	}
	if err != nil && !errors.Is(err, io.EOF) {
		r.once.Do(func() { r.done(false) })
	}
	return n, err
}
func (r *auditReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(func() { r.done(r.complete) })
	return err
}

func (e *edgeServer) requirePrincipal(w http.ResponseWriter, r *http.Request) (principal, bool) {
	pr, ok := e.auth.resolve(r, time.Now())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "AUTH_REQUIRED"})
		return principal{}, false
	}
	return pr, true
}

func (e *edgeServer) validMutation(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	_, ok := e.origins[origin]
	return ok
}

func (e *edgeServer) record(requestID, actor, event, outcome, patientID, encounterID string, status int) error {
	return e.audit.append(auditRecord{RequestID: requestID, Actor: actor, Event: event, Outcome: outcome, PatientID: patientID, Encounter: encounterID, HTTPStatus: status})
}

func (e *edgeServer) isRateLimited(rateKey string) bool {
	e.auth.mu.Lock()
	defer e.auth.mu.Unlock()
	state, ok := e.auth.rates[rateKey]
	return ok && state.BlockedTil.After(time.Now())
}

func rateLimitKey(r *http.Request, username string) string {
	ip := strings.TrimSpace(r.Header.Get("X-Edge-Client-IP"))
	if parsed := net.ParseIP(ip); parsed == nil {
		ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	if net.ParseIP(ip) == nil {
		ip = "unknown"
	}
	return ip + "\x00" + username
}

func (e *edgeServer) activeRunsFor(authSession string) map[string]runBinding {
	e.runsMu.Lock()
	defer e.runsMu.Unlock()
	result := map[string]runBinding{}
	for id, binding := range e.runs {
		if binding.AuthSession == authSession {
			result[id] = binding
		}
	}
	return result
}

func (e *edgeServer) hasRunForSession(sessionID string) bool {
	e.runsMu.Lock()
	defer e.runsMu.Unlock()
	for _, run := range e.runs {
		if run.SessionID == sessionID {
			return true
		}
	}
	return false
}

func (e *edgeServer) cancelUpstream(runID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(e.upstream.String(), "/")+"/api/runs/"+url.PathEscape(runID)+"/cancel", strings.NewReader("{}"))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := e.transport.RoundTrip(request)
	if err == nil {
		_ = response.Body.Close()
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeLimitedJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, destination any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON object")
	}
	return nil
}

func decodeStatus(err error) int {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

func isJSON(r *http.Request) bool {
	value := strings.TrimSpace(strings.ToLower(r.Header.Get("Content-Type")))
	return value == "application/json" || strings.HasPrefix(value, "application/json;")
}

func userView(pr principal) map[string]string {
	return map[string]string{"displayName": pr.DisplayName, "role": pr.Role}
}

func patientIDFromContextPath(path string) (string, error) {
	trimmed := strings.TrimSuffix(strings.TrimPrefix(path, "/api/patients/"), "/context")
	decoded, err := url.PathUnescape(trimmed)
	if err != nil || !safePatientID(decoded) {
		return "", errors.New("invalid patient path")
	}
	return decoded, nil
}

func containsEncounter(patient patientSummary, encounterID string) bool {
	for _, encounter := range patient.Encounters {
		if encounter.EncounterID == encounterID {
			return true
		}
	}
	return false
}

func safePatientID(value string) bool { return value == "patient-htn" || value == "patient-complex" }
func safeEncounterID(value string) bool {
	return value == "demo-encounter-htn" || value == "demo-encounter-complex"
}
func httpOutcome(status int) string {
	if status >= 200 && status < 300 {
		return "allowed"
	}
	return "failed"
}
func randomToken(bytesCount int) string {
	value := make([]byte, bytesCount)
	if _, err := rand.Read(value); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(value)
}
