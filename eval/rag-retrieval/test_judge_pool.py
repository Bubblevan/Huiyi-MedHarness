from __future__ import annotations

import json
import unittest

from judge_pool import SYSTEM_PROMPT, build_user_message, parse_judgments


class JudgePoolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.candidates = [
            {"candidateId": "c1", "source": "textbooks", "title": "Medication reconciliation", "snippet": "Compare the medication list with discharge records."},
            {"candidateId": "c2", "source": "huiyi", "title": "Eye care", "snippet": "This passage is unrelated to medication."},
        ]

    def test_user_message_does_not_expose_method_rank_or_score(self) -> None:
        rendered = build_user_message("How to reconcile medication lists?", self.candidates)
        self.assertNotIn("method", rendered.casefold())
        self.assertNotIn("rank", rendered.casefold())
        self.assertNotIn("score", rendered.casefold())
        self.assertNotIn("sourceUri", rendered)

    def test_parses_exact_candidate_coverage_and_verbatim_quote(self) -> None:
        raw = json.dumps({"judgments": [
            {"candidateId": "c1", "relevanceGrade": 2, "answerSupport": "supported", "evidenceQuote": "Compare the medication list with discharge records.", "conflictType": "none", "explanation": "Directly addresses the requested comparison.", "confidence": 0.92},
            {"candidateId": "c2", "relevanceGrade": 0, "answerSupport": "unsupported", "evidenceQuote": "", "conflictType": "none", "explanation": "It concerns eye care, not medication reconciliation.", "confidence": 0.99},
        ]})
        self.assertEqual([item["candidateId"] for item in parse_judgments(raw, self.candidates)], ["c1", "c2"])

    def test_missing_judgment_is_unresolved_not_defaulted(self) -> None:
        raw = json.dumps({"judgments": [
            {"candidateId": "c1", "relevanceGrade": 2, "answerSupport": "supported", "evidenceQuote": "Compare the medication list with discharge records.", "conflictType": "none", "explanation": "Direct support.", "confidence": 0.92},
        ]})
        with self.assertRaisesRegex(ValueError, "missing_candidate_judgment"):
            parse_judgments(raw, self.candidates)

    def test_non_verbatim_quote_is_rejected(self) -> None:
        raw = json.dumps({"judgments": [
            {"candidateId": "c1", "relevanceGrade": 2, "answerSupport": "supported", "evidenceQuote": "Compare the list with records.", "conflictType": "none", "explanation": "Direct support.", "confidence": 0.92},
            {"candidateId": "c2", "relevanceGrade": 0, "answerSupport": "unsupported", "evidenceQuote": "", "conflictType": "none", "explanation": "Unrelated.", "confidence": 0.99},
        ]})
        with self.assertRaisesRegex(ValueError, "quote_not_found_verbatim_in_passage"):
            parse_judgments(raw, self.candidates)

    def test_system_prompt_forbids_answering_question(self) -> None:
        self.assertIn("Do not answer the medical question", SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
