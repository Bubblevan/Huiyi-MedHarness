from __future__ import annotations

import json
import unittest

from judge_pool import SYSTEM_PROMPT, build_user_message, parse_judgments
from finalize_h2_translation_top10_qrels import valid as valid_translation_label
from resolve_h2_judge_review import valid_label as valid_review_label


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

    def test_topically_relevant_passage_may_not_support_specific_answer(self) -> None:
        raw = json.dumps({"judgments": [
            {"candidateId": "c1", "relevanceGrade": 1, "answerSupport": "unsupported", "evidenceQuote": "Compare the medication list with discharge records.", "conflictType": "none", "explanation": "Topically relevant but contains no patient-specific record.", "confidence": 0.92},
            {"candidateId": "c2", "relevanceGrade": 0, "answerSupport": "unsupported", "evidenceQuote": "", "conflictType": "none", "explanation": "Unrelated to the requested patient-specific fact.", "confidence": 0.99},
        ]})
        parsed = parse_judgments(raw, self.candidates)
        self.assertEqual(parsed[0]["answerSupport"], "unsupported")
        normalized = {
            "relevance_grade": 1,
            "answer_support": "unsupported",
            "conflict_type": "none",
            "parse_status": "ok",
            "confidence": 0.92,
            "evidence_quote": "Compare the medication list with discharge records.",
        }
        self.assertEqual(valid_review_label(normalized, self.candidates[0]["snippet"]), (True, []))
        self.assertEqual(valid_translation_label({**normalized, "explanation": "Relevant, but not the requested fact."}, self.candidates[0]["snippet"]), [])

    def test_grade_zero_cannot_be_marked_as_supported(self) -> None:
        raw = json.dumps({"judgments": [
            {"candidateId": "c1", "relevanceGrade": 0, "answerSupport": "supported", "evidenceQuote": "", "conflictType": "none", "explanation": "Direct support.", "confidence": 0.92},
            {"candidateId": "c2", "relevanceGrade": 0, "answerSupport": "unsupported", "evidenceQuote": "", "conflictType": "none", "explanation": "Unrelated.", "confidence": 0.99},
        ]})
        with self.assertRaisesRegex(ValueError, "relevance_grade_answer_support_mismatch"):
            parse_judgments(raw, self.candidates)

    def test_system_prompt_forbids_answering_question(self) -> None:
        self.assertIn("Do not answer the medical question", SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
