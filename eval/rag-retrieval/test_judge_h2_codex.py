from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))
import judge_h2_codex


class CodexJudgePromptTests(unittest.TestCase):
    def test_prompt_uses_only_blinded_candidate_fields(self) -> None:
        candidate = {
            "candidateId": "C-123",
            "documentId": "private:doc:1",
            "source": "pubmed",
            "title": "Example title",
            "snippet": "Exact candidate passage",
            "method": "dense",
            "rank": 1,
            "score": 0.99,
        }
        prompt = judge_h2_codex._prompt("What is the reported finding?", [candidate])
        self.assertIn("What is the reported finding?", prompt)
        self.assertIn("Exact candidate passage", prompt)
        self.assertIn("C-123", prompt)
        self.assertNotIn("private:doc:1", prompt)
        self.assertNotIn('"method"', prompt)
        self.assertNotIn('"rank"', prompt)
        self.assertNotIn('"score"', prompt)
        self.assertNotIn("taskCategory", prompt)

    def test_schema_is_strict_and_machine_label_only(self) -> None:
        schema = judge_h2_codex._response_schema()
        self.assertEqual(schema["additionalProperties"], False)
        item = schema["properties"]["judgments"]["items"]
        self.assertIn("evidenceQuote", item["required"])
        self.assertNotIn("clinicianApproval", item["properties"])

    def test_partial_response_keeps_valid_candidates_and_flags_bad_quote(self) -> None:
        candidates = [
            {"candidateId": "C-good", "snippet": "The passage states blood pressure."},
            {"candidateId": "C-bad", "snippet": "The passage states heart rate."},
        ]
        response = {"judgments": [
            {"candidateId": "C-good", "relevanceGrade": 2, "answerSupport": "supported", "evidenceQuote": "blood pressure", "conflictType": "none", "explanation": "Directly states the queried fact.", "confidence": 0.9},
            {"candidateId": "C-bad", "relevanceGrade": 2, "answerSupport": "supported", "evidenceQuote": "not in passage", "conflictType": "none", "explanation": "Claims an unsupported quote.", "confidence": 0.9},
        ]}
        valid, errors = judge_h2_codex._validate_partial_response(response, candidates)
        self.assertEqual([item["candidateId"] for item in valid], ["C-good"])
        self.assertEqual(errors, {"C-bad": "quote_not_found_verbatim_in_passage"})

    def test_partial_response_does_not_default_missing_candidate_to_irrelevant(self) -> None:
        candidates = [
            {"candidateId": "C-good", "snippet": "The passage states blood pressure."},
            {"candidateId": "C-missing", "snippet": "Another passage."},
        ]
        response = {"judgments": [
            {"candidateId": "C-good", "relevanceGrade": 2, "answerSupport": "supported", "evidenceQuote": "blood pressure", "conflictType": "none", "explanation": "Directly states the queried fact.", "confidence": 0.9},
        ]}
        valid, errors = judge_h2_codex._validate_partial_response(response, candidates)
        self.assertEqual([item["candidateId"] for item in valid], ["C-good"])
        self.assertEqual(errors, {"C-missing": "missing_or_duplicate_candidate_judgment"})
