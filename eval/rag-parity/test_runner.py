from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from runner import load_inference_cases, run_one


def test_inference_loader_rejects_gold_fields(tmp_path: Path) -> None:
    path = tmp_path / "cases.jsonl"
    path.write_text(json.dumps({
        "id": "1",
        "question": "Q",
        "options": {"A": "a", "B": "b", "C": "c", "D": "d"},
        "answer": "C",
    }) + "\n", encoding="utf-8")

    try:
        load_inference_cases(path)
    except ValueError as exc:
        assert "exactly id, question, options" in str(exc)
    else:
        raise AssertionError("gold-bearing inference input must be rejected")


def test_runner_uses_new_dsh_session_and_counts_native_events(tmp_path: Path, monkeypatch) -> None:
    dsh_home = tmp_path / "dsh-home"
    metadata = {
        "caseId": "content-hash",
        "method": "imedrag",
        "corpusVersion": "fixture",
        "roundsCompleted": 4,
        "generatedQueries": 12,
        "modelCalls": 20,
        "retrievalCalls": 12,
        "parseFailures": 0,
        "history": "must not be copied to the metadata trace",
    }

    def fake_run(command, *, env, **_kwargs):
        assert "--session-id" not in command
        assert command[-1] == "-"
        trace_path = Path(env["HUIYI_RAG_BENCHMARK_TRACE_FILE"])
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        trace_path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")
        events = [
            {"type": "session", "sessionId": "dsh-created-session"},
            {"type": "tool_call", "callId": "call-1", "tool": "research_medical_question"},
            {"type": "tool_result", "callId": "call-1", "status": "completed"},
            {"type": "status", "phase": "turn_end", "reason": {"kind": "completed"}},
            {"type": "final", "text": '{"answer":"B"}'},
        ]
        return SimpleNamespace(
            stdout="".join(json.dumps(event) + "\n" for event in events),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr("runner.subprocess.run", fake_run)
    result = run_one(
        {"id": "validation-1", "question": "Q", "options": {"A": "a", "B": "b", "C": "c", "D": "d"}},
        "imedrag", "hc-rag-002", dsh_home, Path("/usr/bin/node"), Path("/tmp/dsh.js"), 60,
    )

    assert result["sessionId"] == "dsh-created-session"
    assert result["toolCalls"] == 1
    assert result["toolFailures"] == 0
    assert result["turnOutcome"] == "completed"
    assert result["choice"] == "B"
    assert result["researchMetadata"]["roundsCompleted"] == 4
    assert "history" not in result["researchMetadata"]


def test_runner_records_failed_research_tool_result(tmp_path: Path, monkeypatch) -> None:
    dsh_home = tmp_path / "dsh-home"

    def fake_run(_command, **_kwargs):
        events = [
            {"type": "session", "sessionId": "dsh-created-session"},
            {"type": "tool_call", "callId": "call-1", "tool": "research_medical_question"},
            {"type": "tool_result", "callId": "call-1", "status": "error"},
            {"type": "status", "phase": "turn_end", "reason": {"kind": "completed"}},
            {"type": "final", "text": "A"},
        ]
        return SimpleNamespace(
            stdout="".join(json.dumps(event) + "\n" for event in events),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr("runner.subprocess.run", fake_run)
    result = run_one(
        {"id": "validation-2", "question": "Q", "options": {"A": "a", "B": "b", "C": "c", "D": "d"}},
        "imedrag", "hc-rag-002", dsh_home, Path("/usr/bin/node"), Path("/tmp/dsh.js"), 60,
    )

    assert result["toolFailures"] == 1
    assert result["parseStatus"] == "research_tool_failure"
