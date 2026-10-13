package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	cookieName = "huiyi_edge_session"
	sessionTTL = 8 * time.Hour
)

type principal struct {
	TokenHash    string
	AuthSession  string
	Username     string
	DisplayName  string
	Role         string
	PatientScope map[string]bool
	ExpiresAt    time.Time
}

type patientBinding struct {
	SessionID   string
	AuthSession string
	Username    string
	PatientID   string
	EncounterID string
	ExpiresAt   time.Time
}

type rateState struct {
	Failures    int
	BlockedTil  time.Time
	LastAttempt time.Time
}

type authState struct {
	mu       sync.Mutex
	accounts map[string]accountConfig
	sessions map[string]principal
	bindings map[string]patientBinding
	rates    map[string]rateState
	fakeSalt []byte
	fakeHash []byte
}

func newAuthState(accounts []accountConfig) (*authState, error) {
	fakeSalt := make([]byte, 16)
	if _, err := rand.Read(fakeSalt); err != nil {
		return nil, err
	}
	fakeHash := pbkdf2SHA256([]byte("constant-time-fake-password"), fakeSalt, 120_000, 32)
	state := &authState{
		accounts: map[string]accountConfig{}, sessions: map[string]principal{},
		bindings: map[string]patientBinding{}, rates: map[string]rateState{},
		fakeSalt: fakeSalt, fakeHash: fakeHash,
	}
	for _, account := range accounts {
		state.accounts[account.Username] = account
	}
	return state, nil
}

func pbkdf2SHA256(password, salt []byte, iterations, keyLength int) []byte {
	const hashLength = 32
	blocks := (keyLength + hashLength - 1) / hashLength
	result := make([]byte, 0, blocks*hashLength)
	for block := 1; block <= blocks; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Reset()
		_, _ = mac.Write(salt)
		_, _ = mac.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := mac.Sum(nil)
		accumulator := append([]byte(nil), u...)
		for iteration := 1; iteration < iterations; iteration++ {
			mac.Reset()
			_, _ = mac.Write(u)
			u = mac.Sum(nil)
			for i := range accumulator {
				accumulator[i] ^= u[i]
			}
		}
		result = append(result, accumulator...)
	}
	return result[:keyLength]
}

func (a *authState) login(username, password, rateKey string, now time.Time) (string, principal, bool, bool) {
	username = strings.ToLower(strings.TrimSpace(username))
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, session := range a.sessions {
		if !session.ExpiresAt.After(now) {
			delete(a.sessions, key)
		}
	}
	for key, state := range a.rates {
		if now.Sub(state.LastAttempt) > 10*time.Minute {
			delete(a.rates, key)
		}
	}
	if _, exists := a.rates[rateKey]; !exists && len(a.rates) >= 10_000 {
		return "", principal{}, false, true
	}
	entry := a.rates[rateKey]
	if entry.BlockedTil.After(now) {
		return "", principal{}, false, true
	}
	account, exists := a.accounts[username]
	salt, expected := a.fakeSalt, a.fakeHash
	if exists {
		salt, expected = account.salt, account.verifier
	}
	iterations := 120_000
	if exists {
		iterations = account.Iterations
	}
	supplied := pbkdf2SHA256([]byte(password), salt, iterations, 32)
	if !exists || !hmac.Equal(supplied, expected) {
		entry.Failures++
		entry.LastAttempt = now
		if entry.Failures >= 5 {
			entry.BlockedTil = now.Add(5 * time.Minute)
		}
		a.rates[rateKey] = entry
		return "", principal{}, false, entry.Failures >= 5
	}
	delete(a.rates, rateKey)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", principal{}, false, false
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	authSessionBytes := make([]byte, 16)
	if _, err := rand.Read(authSessionBytes); err != nil {
		return "", principal{}, false, false
	}
	pr := principal{
		TokenHash: hashToken(token), AuthSession: hex.EncodeToString(authSessionBytes),
		Username: account.Username, DisplayName: account.DisplayName, Role: account.Role,
		PatientScope: account.patientScopes, ExpiresAt: now.Add(sessionTTL),
	}
	a.sessions[pr.TokenHash] = pr
	return token, pr, true, false
}

func (a *authState) resolve(request *http.Request, now time.Time) (principal, bool) {
	cookie, err := request.Cookie(cookieName)
	if err != nil || cookie.Value == "" {
		return principal{}, false
	}
	hash := hashToken(cookie.Value)
	a.mu.Lock()
	defer a.mu.Unlock()
	pr, ok := a.sessions[hash]
	if !ok || !pr.ExpiresAt.After(now) {
		delete(a.sessions, hash)
		return principal{}, false
	}
	return pr, true
}

func (a *authState) revoke(request *http.Request) (principal, bool, []string) {
	cookie, err := request.Cookie(cookieName)
	if err != nil || cookie.Value == "" {
		return principal{}, false, nil
	}
	hash := hashToken(cookie.Value)
	a.mu.Lock()
	defer a.mu.Unlock()
	pr, ok := a.sessions[hash]
	delete(a.sessions, hash)
	if !ok {
		return principal{}, false, nil
	}
	removedRuns := make([]string, 0)
	for id, binding := range a.bindings {
		if binding.AuthSession == pr.AuthSession {
			delete(a.bindings, id)
		}
	}
	return pr, true, removedRuns
}

func (a *authState) createBinding(pr principal, patientID, encounterID, sessionID string) patientBinding {
	binding := patientBinding{SessionID: sessionID, AuthSession: pr.AuthSession, Username: pr.Username, PatientID: patientID, EncounterID: encounterID, ExpiresAt: pr.ExpiresAt}
	a.mu.Lock()
	a.bindings[sessionID] = binding
	a.mu.Unlock()
	return binding
}

func (a *authState) resolveBinding(pr principal, sessionID string, now time.Time) (patientBinding, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	binding, ok := a.bindings[sessionID]
	if !ok || !binding.ExpiresAt.After(now) || binding.AuthSession != pr.AuthSession || binding.Username != pr.Username {
		delete(a.bindings, sessionID)
		return patientBinding{}, false
	}
	return binding, true
}

func (a *authState) closeBinding(pr principal, sessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	binding, ok := a.bindings[sessionID]
	if !ok || binding.AuthSession != pr.AuthSession || binding.Username != pr.Username {
		return false
	}
	delete(a.bindings, sessionID)
	return true
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func cookieHeader(token string, secure bool) string {
	value := cookieName + "=" + token + "; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800"
	if secure {
		value += "; Secure"
	}
	return value
}

func clearCookieHeader(secure bool) string {
	value := cookieName + "=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0"
	if secure {
		value += "; Secure"
	}
	return value
}
