package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestPBKDF2SHA256KnownVector(t *testing.T) {
	got := pbkdf2SHA256([]byte("password"), []byte("salt"), 1, 32)
	want := "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
	if gotHex := fmtHex(got); gotHex != want {
		t.Fatalf("PBKDF2 vector mismatch: got %s", gotHex)
	}
}

func TestEdgeAuthPatientIsolationAndMetadataOnlyAudit(t *testing.T) {
	const password = "edge-test-password-not-real-0123"
	var upstreamChatBody map[string]any
	var complexPatientContextRequests int
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		status := http.StatusOK
		body := ""
		headers := make(http.Header)
		switch request.URL.Path {
		case "/api/health":
			body = `{"status":"ok","backend":"dsh","modelName":"hidden"}`
		case "/api/demo/patients/patient-htn":
			headers.Set("Content-Type", "application/json")
			body = `{"patientId":"patient-htn","displayName":"张某","age":52,"sex":"男","encounter":"模拟复诊","conditions":[],"medications":[],"allergies":[],"memory":{"summary":"仅用于测试","items":1,"updatedLabel":"上次复诊"},"suggestedQuestion":"问题"}`
		case "/api/demo/patients/patient-complex":
			complexPatientContextRequests++
		case "/api/chat":
			if err := json.NewDecoder(request.Body).Decode(&upstreamChatBody); err != nil {
				t.Errorf("decode upstream chat: %v", err)
			}
			headers.Set("Content-Type", "text/event-stream")
			headers.Set("X-Run-ID", "run-test-1")
			body = "event: run.started\ndata: {}\n\nevent: run.completed\ndata: {}\n\n"
		default:
			status = http.StatusNotFound
		}
		return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})

	salt := bytes.Repeat([]byte{0x47}, 16)
	iterations := 120_000
	verifier := pbkdf2SHA256([]byte(password), salt, iterations, 32)
	config, err := json.Marshal([]map[string]any{{
		"username": "clinician-a", "displayName": "测试医护", "role": "clinician",
		"salt":             base64.RawStdEncoding.EncodeToString(salt),
		"passwordVerifier": base64.RawStdEncoding.EncodeToString(verifier),
		"iterations":       iterations, "patientIds": []string{"patient-htn"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	accounts, err := parseAccounts(string(config))
	if err != nil {
		t.Fatal(err)
	}
	upstreamURL, _ := url.Parse("http://127.0.0.1:8320")
	auditPath := filepath.Join(t.TempDir(), "audit.jsonl")
	audit, err := newAuditLog(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	edge, err := newEdgeServer(accounts, upstreamURL, map[string]struct{}{"http://edge.test": {}}, audit, false)
	if err != nil {
		t.Fatal(err)
	}
	edge.transport = transport

	unauthorized := edgeCall(t, edge, http.MethodGet, "/api/patients", nil, "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated patient list returned %d", unauthorized.Code)
	}

	badOrigin := edgeCallWithOrigin(t, edge, http.MethodPost, "/api/auth/login", nil, `{"username":"clinician-a","password":"x"}`, "http://attacker.test")
	if badOrigin.Code != http.StatusForbidden {
		t.Fatalf("disallowed Origin returned %d", badOrigin.Code)
	}

	login := edgeCall(t, edge, http.MethodPost, "/api/auth/login", nil, `{"username":"clinician-a","password":"`+password+`"}`)
	if login.Code != http.StatusOK {
		t.Fatalf("login returned %d: %s", login.Code, login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie missing security attributes: %#v", cookies)
	}
	cookie := cookies[0]

	list := edgeCall(t, edge, http.MethodGet, "/api/patients", cookie, "")
	var patientList struct {
		Patients []patientSummary `json:"patients"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &patientList); err != nil {
		t.Fatal(err)
	}
	if list.Code != http.StatusOK || len(patientList.Patients) != 1 || patientList.Patients[0].PatientID != "patient-htn" {
		t.Fatalf("patient list escaped account scope: status=%d patients=%#v", list.Code, patientList.Patients)
	}

	deniedContext := edgeCall(t, edge, http.MethodGet, "/api/patients/patient-complex/context?encounterId=demo-encounter-complex", cookie, "")
	if deniedContext.Code != http.StatusNotFound || complexPatientContextRequests != 0 {
		t.Fatalf("cross-patient context was not blocked before proxy: status=%d proxyCount=%d", deniedContext.Code, complexPatientContextRequests)
	}

	newSession := edgeCall(t, edge, http.MethodPost, "/api/sessions", cookie, `{"patientId":"patient-htn","encounterId":"demo-encounter-htn"}`)
	if newSession.Code != http.StatusCreated {
		t.Fatalf("authorized session returned %d: %s", newSession.Code, newSession.Body.String())
	}
	var session struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(newSession.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}

	message := "PRIVATE_PROMPT_MUST_NOT_BE_AUDITED"
	deniedChatBody := `{"sessionId":"` + session.SessionID + `","patientId":"patient-complex","encounterId":"demo-encounter-complex","message":"` + message + `"}`
	deniedChat := edgeCall(t, edge, http.MethodPost, "/api/chat", cookie, deniedChatBody)
	if deniedChat.Code != http.StatusNotFound {
		t.Fatalf("cross-patient turn returned %d", deniedChat.Code)
	}

	chatBody := `{"sessionId":"` + session.SessionID + `","patientId":"patient-htn","encounterId":"demo-encounter-htn","message":"` + message + `"}`
	chat := edgeCall(t, edge, http.MethodPost, "/api/chat", cookie, chatBody)
	if chat.Code != http.StatusOK || !strings.Contains(chat.Body.String(), "run.completed") {
		t.Fatalf("authorized stream failed: status=%d body=%s", chat.Code, chat.Body.String())
	}
	if upstreamChatBody["patientId"] != "patient-htn" || upstreamChatBody["scenario"] != nil || upstreamChatBody["encounterId"] != nil {
		t.Fatalf("unexpected forwarded chat fields: %#v", upstreamChatBody)
	}

	logout := edgeCall(t, edge, http.MethodPost, "/api/auth/logout", cookie, `{}`)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout returned %d", logout.Code)
	}
	afterLogout := edgeCall(t, edge, http.MethodGet, "/api/patients", cookie, "")
	if afterLogout.Code != http.StatusUnauthorized {
		t.Fatalf("logout did not revoke session: %d", afterLogout.Code)
	}

	contents, err := os.ReadFile(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), message) || strings.Contains(string(contents), password) {
		t.Fatal("audit log contained prompt or password text")
	}
	for _, required := range []string{"auth.login", "patient.list", "session.create", "chat.start", "chat.result", "auth.logout", "patient-htn", "patient-complex"} {
		if !strings.Contains(string(contents), required) {
			t.Errorf("audit log missing %q", required)
		}
	}
}

func edgeCall(t *testing.T, edge http.Handler, method, target string, cookie *http.Cookie, body string) *httptest.ResponseRecorder {
	return edgeCallWithOrigin(t, edge, method, target, cookie, body, "http://edge.test")
}

func edgeCallWithOrigin(t *testing.T, edge http.Handler, method, target string, cookie *http.Cookie, body, origin string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	edge.ServeHTTP(response, request)
	return response
}

func fmtHex(value []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(value)*2)
	for i, b := range value {
		out[i*2], out[i*2+1] = digits[b>>4], digits[b&15]
	}
	return string(out)
}
