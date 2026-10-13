package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxAuditBytes = 50 << 20

type auditRecord struct {
	Timestamp  string `json:"timestamp"`
	RequestID  string `json:"requestId"`
	Actor      string `json:"actor,omitempty"`
	Event      string `json:"event"`
	PatientID  string `json:"patientId,omitempty"`
	Encounter  string `json:"encounterId,omitempty"`
	Outcome    string `json:"outcome"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
}

type auditLog struct {
	mu   sync.Mutex
	file *os.File
}

func newAuditLog(path string) (*auditLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &auditLog{file: file}, nil
}

func (a *auditLog) append(record auditRecord) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	info, err := a.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() >= maxAuditBytes {
		return errors.New("audit log capacity reached")
	}
	if record.Timestamp == "" {
		record.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if info.Size()+int64(len(encoded)) > maxAuditBytes {
		return errors.New("audit log capacity reached")
	}
	if _, err := a.file.Write(encoded); err != nil {
		return err
	}
	return a.file.Sync()
}

func (a *auditLog) Close() error { return a.file.Close() }
