package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxEdgeTraceBytes = 25 << 20

type edgeTraceRecord struct {
	Timestamp             string         `json:"timestamp"`
	TraceID               string         `json:"traceId"`
	RunID                 string         `json:"runId,omitempty"`
	Event                 string         `json:"event"`
	ElapsedMS             int64          `json:"elapsedMs,omitempty"`
	HTTPStatus            int            `json:"httpStatus,omitempty"`
	ContentType           string         `json:"contentType,omitempty"`
	Reason                string         `json:"reason,omitempty"`
	SSEBytes              int64          `json:"sseBytes,omitempty"`
	SSEEventCount         int            `json:"sseEventCount,omitempty"`
	EventCounts           map[string]int `json:"eventCounts,omitempty"`
	AssistantDeltaCount   int            `json:"assistantDeltaCount,omitempty"`
	AssistantChars        int            `json:"assistantChars,omitempty"`
	FirstByteMS           int64          `json:"firstByteMs"`
	FirstEventMS          int64          `json:"firstEventMs"`
	FirstAssistantDeltaMS int64          `json:"firstAssistantDeltaMs"`
	LastEvent             string         `json:"lastEvent,omitempty"`
	FailureCode           string         `json:"failureCode,omitempty"`
}

type edgeTraceLog struct {
	mu   sync.Mutex
	file *os.File
	path string
}

func newEdgeTraceLog(path string) (*edgeTraceLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &edgeTraceLog{file: f, path: path}, nil
}

func (t *edgeTraceLog) append(record edgeTraceRecord) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file == nil {
		return
	}
	if record.Timestamp == "" {
		record.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	line, err := json.Marshal(record)
	if err != nil {
		return
	}
	line = append(line, '\n')
	info, err := t.file.Stat()
	if err != nil {
		return
	}
	if info.Size()+int64(len(line)) > maxEdgeTraceBytes {
		_ = t.file.Close()
		backup := t.path + ".1"
		_ = os.Remove(backup)
		if err := os.Rename(t.path, backup); err != nil {
			t.file = nil
			return
		}
		t.file, err = os.OpenFile(t.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			t.file = nil
			return
		}
		_ = t.file.Chmod(0o600)
	}
	_, _ = t.file.Write(line)
}

func (t *edgeTraceLog) Close() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file == nil {
		return nil
	}
	err := t.file.Close()
	t.file = nil
	return err
}

type edgeStreamObserver struct {
	mu                    sync.Mutex
	trace                 *edgeTraceLog
	traceID               string
	runID                 string
	started               time.Time
	requestContext        interface{ Err() error }
	bytes                 int64
	events                int
	eventCounts           map[string]int
	assistantDeltaCount   int
	assistantChars        int
	firstByteMS           int64
	firstEventMS          int64
	firstAssistantDeltaMS int64
	lastEvent             string
	failureCode           string
	contentType           string
	line                  []byte
	pendingEvent          string
	pendingData           []byte
	terminal              bool
	done                  chan struct{}
	doneOnce              sync.Once
}

func newEdgeStreamObserver(trace *edgeTraceLog, traceID string, started time.Time, requestContext interface{ Err() error }) *edgeStreamObserver {
	return &edgeStreamObserver{
		trace: trace, traceID: traceID, started: started, requestContext: requestContext,
		eventCounts: map[string]int{}, firstByteMS: -1, firstEventMS: -1, firstAssistantDeltaMS: -1,
		done: make(chan struct{}),
	}
}

func (o *edgeStreamObserver) setRunID(runID string) {
	if safeTraceIdentifier(runID) {
		o.mu.Lock()
		o.runID = runID
		o.mu.Unlock()
	}
}

func (o *edgeStreamObserver) responseHeaders(runID, contentType string, status int) {
	o.mu.Lock()
	if safeTraceIdentifier(runID) {
		o.runID = runID
	}
	o.contentType = contentTypeClass(contentType)
	o.mu.Unlock()
	o.record("edge.chat.response_headers", "received", status)
}

func safeTraceIdentifier(value string) bool {
	return len(value) >= 8 && len(value) <= 80 && regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(value)
}

func (o *edgeStreamObserver) snapshot(event, reason string, status int) edgeTraceRecord {
	o.mu.Lock()
	defer o.mu.Unlock()
	counts := make(map[string]int, len(o.eventCounts))
	for name, count := range o.eventCounts {
		counts[name] = count
	}
	return edgeTraceRecord{
		TraceID: o.traceID, RunID: o.runID, Event: event, ElapsedMS: time.Since(o.started).Milliseconds(),
		HTTPStatus: status, Reason: reason, SSEBytes: o.bytes, SSEEventCount: o.events,
		ContentType: o.contentType,
		EventCounts: counts, AssistantDeltaCount: o.assistantDeltaCount, AssistantChars: o.assistantChars,
		FirstByteMS: o.firstByteMS, FirstEventMS: o.firstEventMS, FirstAssistantDeltaMS: o.firstAssistantDeltaMS,
		LastEvent: o.lastEvent, FailureCode: o.failureCode,
	}
}

func (o *edgeStreamObserver) record(event, reason string, status int) {
	if o.trace != nil {
		o.trace.append(o.snapshot(event, reason, status))
	}
}

func (o *edgeStreamObserver) progress() {
	o.record("edge.chat.heartbeat", "in_progress", 0)
}

func (o *edgeStreamObserver) observe(chunk []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(chunk) == 0 || o.terminal {
		return
	}
	o.bytes += int64(len(chunk))
	if o.firstByteMS < 0 {
		o.firstByteMS = time.Since(o.started).Milliseconds()
	}
	for _, b := range chunk {
		if b == '\n' {
			line := strings.TrimSuffix(string(o.line), "\r")
			o.line = o.line[:0]
			o.consumeLine(line)
		} else if len(o.line) < 32_768 {
			o.line = append(o.line, b)
		}
	}
}

func (o *edgeStreamObserver) consumeLine(line string) {
	if strings.HasPrefix(line, "event:") {
		o.pendingEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		return
	}
	if strings.HasPrefix(line, "data:") {
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if len(o.pendingData)+len(data) <= 32_768 {
			o.pendingData = append(o.pendingData, data...)
		}
		return
	}
	if line != "" {
		return
	}
	name := safeSSEEventName(o.pendingEvent)
	if name != "" {
		o.events++
		o.eventCounts[name]++
		o.lastEvent = name
		if o.firstEventMS < 0 {
			o.firstEventMS = time.Since(o.started).Milliseconds()
		}
		if name == "assistant.delta" {
			o.assistantDeltaCount++
			var payload struct {
				Data struct {
					Text string `json:"text"`
				} `json:"data"`
			}
			if json.Unmarshal(o.pendingData, &payload) == nil {
				o.assistantChars += len([]rune(payload.Data.Text))
			}
			if o.firstAssistantDeltaMS < 0 {
				o.firstAssistantDeltaMS = time.Since(o.started).Milliseconds()
			}
		}
		if name == "run.failed" {
			var payload struct {
				Data struct {
					Code string `json:"code"`
				} `json:"data"`
			}
			if json.Unmarshal(o.pendingData, &payload) == nil && regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,40}$`).MatchString(payload.Data.Code) {
				o.failureCode = payload.Data.Code
			}
		}
	}
	o.pendingEvent = ""
	o.pendingData = o.pendingData[:0]
}

func safeSSEEventName(value string) string {
	known := map[string]bool{
		"run.started": true, "context.patient": true, "context.memory": true,
		"assistant.delta": true, "tool.started": true, "tool.completed": true,
		"evidence.started": true, "evidence.item": true, "collaboration.started": true,
		"collaboration.completed": true, "draft.updated": true, "draft.save_failed": true,
		"run.completed": true, "run.failed": true, "run.cancelled": true,
	}
	if known[value] {
		return value
	}
	if value == "" {
		return ""
	}
	return "other"
}

func (o *edgeStreamObserver) finish(reason string, status int) {
	o.mu.Lock()
	if o.terminal {
		o.mu.Unlock()
		return
	}
	if reason == "upstream_eof" {
		switch o.lastEvent {
		case "run.completed":
			reason = "terminal_completed"
		case "run.failed":
			reason = "terminal_failed"
		case "run.cancelled":
			reason = "terminal_cancelled"
		default:
			reason = "upstream_eof_without_terminal_event"
		}
	}
	o.terminal = true
	o.mu.Unlock()
	o.doneOnce.Do(func() { close(o.done) })
	o.record("edge.chat.terminal", reason, status)
}

type tracedStreamBody struct {
	io.ReadCloser
	observer *edgeStreamObserver
	status   int
	ctx      interface{ Err() error }
	once     sync.Once
	complete bool
}

func (r *tracedStreamBody) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.observer.observe(p[:n])
	}
	if errors.Is(err, io.EOF) {
		r.complete = true
		r.once.Do(func() { r.observer.finish("upstream_eof", r.status) })
	}
	if err != nil && !errors.Is(err, io.EOF) {
		reason := "upstream_read_error"
		if r.ctx != nil && r.ctx.Err() != nil {
			reason = "client_disconnected"
		}
		r.once.Do(func() { r.observer.finish(reason, r.status) })
	}
	return n, err
}

func (r *tracedStreamBody) Close() error {
	err := r.ReadCloser.Close()
	if !r.complete {
		reason := "stream_closed"
		if r.ctx != nil && r.ctx.Err() != nil {
			reason = "client_disconnected"
		}
		r.once.Do(func() { r.observer.finish(reason, r.status) })
	}
	return err
}

func contentTypeClass(value string) string {
	mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	switch mediaType {
	case "text/event-stream", "application/json":
		return mediaType
	default:
		return "other"
	}
}
