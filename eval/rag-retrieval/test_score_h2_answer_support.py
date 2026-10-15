import unittest

from score_h2_answer_support import summarize


class AnswerSupportScoreTests(unittest.TestCase):
    def test_keeps_claim_and_citation_denominators_separate(self):
        packet_tasks = {
            "d-1": {"evidenceSet": [{"evidenceId": "E1", "sourceUri": "https://example.test/source"}]},
            "f-1": {"evidenceSet": [{"evidenceId": "E1", "sourceUri": None}]},
        }
        private_map = {
            "d-1": {"questionId": "Q1", "method": "D", "taskCategory": "semantic", "answerability": "answerable"},
            "f-1": {"questionId": "Q2", "method": "F", "taskCategory": "no_answer", "answerability": "no_answer"},
        }
        items = [
            {
                "itemKey": "d-1", "generationStatus": "ok", "abstained": False,
                "answerRelevancy": "relevant", "judgeStatus": "ok",
                "claims": [{
                    "support": "supported", "citedEvidenceIds": ["E1"],
                    "validCitedEvidenceIds": ["E1"],
                }],
            },
            {
                "itemKey": "f-1", "generationStatus": "ok", "abstained": True,
                "answerRelevancy": "relevant", "judgeStatus": "ok", "claims": [],
            },
        ]

        result = summarize(items, private_map, packet_tasks)

        self.assertEqual(result["methods"]["D"]["fullySupportedClaimRateAmongAssessable"], 1.0)
        self.assertEqual(result["methods"]["D"]["citationIdValidityRate"], 1.0)
        self.assertEqual(result["methods"]["D"]["sourceUriMetadataCoverageAmongValidCitations"], 1.0)
        self.assertEqual(result["methods"]["F"]["abstentionCount"], 1)
        self.assertIsNone(result["methods"]["F"]["fullySupportedClaimRateAmongAssessable"])


if __name__ == "__main__":
    unittest.main()
