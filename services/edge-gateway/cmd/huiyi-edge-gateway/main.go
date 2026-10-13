package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	accountsRaw := os.Getenv("HUIYI_EDGE_ACCOUNTS_JSON")
	if encoded := os.Getenv("HUIYI_EDGE_ACCOUNTS_B64"); encoded != "" {
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			log.Fatal("HUIYI_EDGE_ACCOUNTS_B64 is invalid")
		}
		accountsRaw = string(data)
	}
	accounts, err := parseAccounts(accountsRaw)
	if err != nil {
		log.Fatalf("invalid edge account configuration: %v", err)
	}
	address := envOr("HUIYI_EDGE_LISTEN_ADDRESS", "127.0.0.1:8321")
	if err := requireLoopbackAddress(address); err != nil {
		log.Fatal(err)
	}
	upstream, err := url.Parse(envOr("HUIYI_EDGE_UPSTREAM", "http://127.0.0.1:8320"))
	if err != nil || upstream.Scheme != "http" || !isLoopbackHost(upstream.Hostname()) {
		log.Fatal("HUIYI_EDGE_UPSTREAM must be an http URL on loopback")
	}
	origins := splitSet(envOr("HUIYI_EDGE_ALLOWED_ORIGINS", "http://127.0.0.1:18080,http://localhost:18080"))
	if len(origins) == 0 {
		log.Fatal("HUIYI_EDGE_ALLOWED_ORIGINS must contain at least one exact origin")
	}
	for origin := range origins {
		parsed, parseErr := url.Parse(origin)
		if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Path != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			log.Fatalf("HUIYI_EDGE_ALLOWED_ORIGINS contains an invalid origin: %q", origin)
		}
	}
	auditPath := envOr("HUIYI_EDGE_AUDIT_PATH", "/var/log/huiyi-edge/audit.jsonl")
	audit, err := newAuditLog(auditPath)
	if err != nil {
		log.Fatalf("cannot initialize edge audit log: %v", err)
	}
	defer audit.Close()
	tracePath := envOr("HUIYI_EDGE_TRACE_PATH", "/var/lib/huiyi-edge/trace.jsonl")
	trace, err := newEdgeTraceLog(tracePath)
	if err != nil {
		log.Fatalf("cannot initialize edge trace log: %v", err)
	}
	defer trace.Close()
	secureCookie := strings.TrimSpace(os.Getenv("HUIYI_EDGE_COOKIE_SECURE")) == "1"
	edge, err := newEdgeServer(accounts, upstream, origins, audit, secureCookie, trace)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{
		Addr: address, Handler: edge,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Huiyi edge gateway listening on %s; upstream is loopback-only; metadata trace at %s", address, tracePath)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func splitSet(raw string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			result[value] = struct{}{}
		}
	}
	return result
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func requireLoopbackAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil || !isLoopbackHost(host) {
		return fmt.Errorf("HUIYI_EDGE_LISTEN_ADDRESS must bind to loopback only")
	}
	return nil
}

func parseAccounts(raw string) ([]accountConfig, error) {
	var accounts []accountConfig
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&accounts); err != nil || len(accounts) == 0 {
		return nil, fmt.Errorf("HUIYI_EDGE_ACCOUNTS_JSON must contain at least one configured account")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("HUIYI_EDGE_ACCOUNTS_JSON must contain exactly one JSON array")
	}
	seen := map[string]bool{}
	for i := range accounts {
		a := &accounts[i]
		a.Username = strings.ToLower(strings.TrimSpace(a.Username))
		if len(a.Username) < 3 || len(a.Username) > 64 || !safeIdentifier(a.Username) || seen[a.Username] {
			return nil, fmt.Errorf("account %d has an invalid or duplicate username", i)
		}
		seen[a.Username] = true
		if strings.TrimSpace(a.DisplayName) == "" || len(a.DisplayName) > 80 {
			return nil, fmt.Errorf("account %d has an invalid display name", i)
		}
		if a.Role != "clinician" && a.Role != "administrator" {
			return nil, fmt.Errorf("account %d has an unsupported role", i)
		}
		salt, err := base64.RawStdEncoding.DecodeString(a.Salt)
		if err != nil || len(salt) < 16 || len(salt) > 64 {
			return nil, fmt.Errorf("account %d has an invalid password salt", i)
		}
		a.salt = salt
		verifier, err := base64.RawStdEncoding.DecodeString(a.PasswordVerifier)
		if err != nil || len(verifier) != 32 {
			return nil, fmt.Errorf("account %d has an invalid password verifier", i)
		}
		a.verifier = verifier
		if a.Iterations < 100_000 || a.Iterations > 2_000_000 {
			return nil, fmt.Errorf("account %d password iteration count is outside allowed bounds", i)
		}
		if len(a.PatientIDs) == 0 {
			return nil, fmt.Errorf("account %d must be granted at least one patient", i)
		}
		a.patientScopes = map[string]bool{}
		for _, patientID := range a.PatientIDs {
			if !isKnownPatient(patientID) {
				return nil, fmt.Errorf("account %d contains an unknown patient scope", i)
			}
			a.patientScopes[patientID] = true
		}
	}
	return accounts, nil
}

func safeIdentifier(value string) bool {
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("._-", r)) {
			return false
		}
	}
	return true
}
