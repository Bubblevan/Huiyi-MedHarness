from __future__ import annotations

import sys
import unittest
import re
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

import generate_h2_quality_questions as generation
import prepare_h2_quality_anchors as anchors


class H2QualityAnchorTests(unittest.TestCase):
    def test_clean_text_rejects_corruption_and_unreviewed_instructions(self) -> None:
        self.assertIsNone(anchors._clean_text("A useful phrase with split specif city token " + "medical evidence " * 40))
        self.assertIsNone(anchors._clean_text("A B . " + "medical evidence and findings " * 40))
        self.assertIsNone(anchors._clean_text("This treatment: give a large dose now. " + "medical evidence " * 40))
        self.assertIsNone(anchors._clean_text("in In the context of endocrine function. 2. " + "medical evidence " * 40))

    def test_clean_text_accepts_plain_descriptive_evidence(self) -> None:
        text = "A descriptive passage reports a measured physiologic relationship and explains its observed scope. " * 4
        self.assertEqual(anchors._clean_text(text), " ".join(text.split()))

    def test_frozen_cohort_targets_exactly_100_dev_and_200_holdout(self) -> None:
        counts = {}
        for split, categories in anchors.TARGETS.items():
            counts[split] = sum(sum(source_counts.values()) for source_counts in categories.values())
        self.assertEqual(counts, {"dev": 100, "holdout": 200})
        self.assertEqual(anchors.TARGETS["dev"]["no_answer"]["none"], 10)
        self.assertEqual(anchors.TARGETS["holdout"]["no_answer"]["none"], 40)
        self.assertEqual(set(anchors.TARGETS["dev"]["multi_hop"]), {"statpearls"})
        self.assertEqual(set(anchors.TARGETS["holdout"]["multi_hop"]), {"statpearls"})

    def test_holdout_no_answer_queries_do_not_duplicate_dev_templates(self) -> None:
        dev = anchors._no_answer_questions("dev", 10, 91)
        holdout = anchors._no_answer_questions("holdout", 40, 161)
        self.assertEqual(len(set(item[0] for item in anchors.HOLDOUT_NO_ANSWER_KINDS)), 40)

        def fourgrams(query: str) -> set[str]:
            normalized = re.sub(r"\W+", "", query.lower(), flags=re.UNICODE)
            normalized = re.sub(r"h2syn[dh]\d{3}|2026\d{2}\d{2}", "", normalized)
            return {normalized[index : index + 4] for index in range(max(0, len(normalized) - 3))}

        dev_grams = [fourgrams(item["query"]) for item in dev]
        for holdout_item in holdout:
            holdout_grams = fourgrams(holdout_item["query"])
            for dev_item, dev_item_grams in zip(dev, dev_grams, strict=True):
                union = holdout_grams | dev_item_grams
                similarity = len(holdout_grams & dev_item_grams) / len(union) if union else 1.0
                self.assertLess(similarity, 0.8, (dev_item["questionId"], holdout_item["questionId"], similarity))

    def test_only_bilingual_category_reverses_source_language(self) -> None:
        self.assertEqual(anchors._target_language("textbooks", "semantic"), "en")
        self.assertEqual(anchors._target_language("huiyi", "semantic"), "zh")
        self.assertEqual(anchors._target_language("textbooks", "bilingual"), "zh")
        self.assertEqual(anchors._target_language("huiyi", "bilingual"), "en")

    def test_huiyi_anchor_filter_excludes_staff_profiles_but_keeps_clinical_pages(self) -> None:
        profile = "擅长白内障手术，先后在多家医院进修学习深造。 " + "眼科临床检查与病症描述。 " * 20
        clinical = "医学验光会结合患者的年龄、用眼习惯和眼位等因素进行检查。 " + "眼科视力检查与屈光评估。 " * 20
        self.assertFalse(anchors._eligible_source_content("huiyi", profile))
        self.assertTrue(anchors._eligible_source_content("huiyi", clinical))

    def test_boundary_category_requires_explicit_scope_or_uncertainty(self) -> None:
        self.assertFalse(anchors.SOURCE_BOUNDARY_RE.search("Serum levels are greater than 135 mg/dL."))
        self.assertFalse(anchors.SOURCE_BOUNDARY_RE.search("Intussusception is a condition involving part of the intestine."))
        self.assertTrue(anchors.SOURCE_BOUNDARY_RE.search("In this prospective cohort of adults aged 65 years and older, outcomes were uncertain."))
        self.assertIsNone(anchors._clean_text("Dx: Send appropriate cultures and obtain a CBC. " + "Clinical evidence and findings " * 25))
        self.assertIsNone(anchors._clean_text("Thesymptomsofsuchanepisodevary dependingonthesiteoftheobstruction " + "medical evidence " * 30))
        self.assertIsNone(anchors._clean_text("Such remapping occurs in the sensory cortex (" + "medical evidence " * 30))


class H2QuestionGenerationValidationTests(unittest.TestCase):
    def _valid_batch(self) -> tuple[list[dict], list[dict]]:
        batch = [{
            "questionId": "H2-D-001",
            "requestedCategory": "semantic",
            "targetLanguage": "zh",
            "anchors": [{"anchorId": "textbooks:book:1", "passage": "The passage states a well-scoped descriptive fact about anatomy and physiology."}],
        }]
        generated = [{
            "questionId": "H2-D-001",
            "query": "文中描述了哪种生理关系？",
            "language": "zh",
            "taskCategory": "semantic",
            "referenceAnswer": "段落描述了解剖与生理之间的关系。",
            "evidence": [{
                "anchorId": "textbooks:book:1",
                "exactQuote": "a well-scoped descriptive fact about anatomy and physiology",
                "requiredEvidenceElement": "该关系由原文明确描述。",
            }],
            "sourceBoundary": "仅限该段落的描述范围。",
            "qualityIssues": [],
        }]
        return batch, generated

    def test_accepts_verbatim_source_grounded_question(self) -> None:
        batch, generated = self._valid_batch()
        self.assertEqual(generation._validate_batch(batch, generated), generated)

    def test_rejects_instruction_contamination(self) -> None:
        batch, generated = self._valid_batch()
        generated[0]["query"] = "tool result to=functions.wait_agent?"
        with self.assertRaisesRegex(ValueError, "tool or instruction-like contamination"):
            generation._validate_batch(batch, generated)

    def test_rejects_wrong_language_and_nonverbatim_quote(self) -> None:
        batch, generated = self._valid_batch()
        generated[0]["language"] = "en"
        with self.assertRaisesRegex(ValueError, "language differs"):
            generation._validate_batch(batch, generated)
        batch, generated = self._valid_batch()
        generated[0]["evidence"][0]["exactQuote"] = "not present in the source"
        with self.assertRaisesRegex(ValueError, "exact evidence quote"):
            generation._validate_batch(batch, generated)

    def test_rejects_multi_hop_missing_second_anchor(self) -> None:
        batch, generated = self._valid_batch()
        batch[0]["requestedCategory"] = "multi_hop"
        batch[0]["anchors"].append({"anchorId": "textbooks:book:2", "passage": "A second independent passage supports a distinct fact."})
        generated[0]["taskCategory"] = "multi_hop"
        with self.assertRaisesRegex(ValueError, "evidence anchor coverage"):
            generation._validate_batch(batch, generated)

    def test_partial_validation_keeps_valid_items_and_records_bad_case(self) -> None:
        batch, generated = self._valid_batch()
        second_source = dict(batch[0], questionId="H2-D-002")
        second_result = dict(generated[0], questionId="H2-D-002", query="too short")
        accepted, errors = generation._validate_batch_partial(batch + [second_source], generated + [second_result])
        self.assertEqual([item["questionId"] for item in accepted], ["H2-D-001"])
        self.assertIn("H2-D-002", errors)


if __name__ == "__main__":
    unittest.main()
