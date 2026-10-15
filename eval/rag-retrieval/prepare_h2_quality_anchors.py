#!/usr/bin/env python3
"""Prepare a fixed, source-grounded H2 DEV/HOLDOUT generation cohort.

This reads the existing five-source sparse metadata and frozen chunk JSONL only.
It does not rebuild the index, modify corpus files, or write source passages into
tracked evaluation artifacts. Private anchor packets belong under the ignored
Health Engine data directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


SEED = 20261015
SOURCE_BOUNDARY_RE = re.compile(
    r"\b(preliminary|limited evidence|uncertain|unclear|unknown|only|among|"
    r"randomi[sz]ed|controlled trial|cohort|case-control|cross-sectional|prospective|"
    r"retrospective|participants|subjects|suggest|possible|not established|"
    r"within\s+\d+|after\s+\d+|before\s+\d+|during\s+\d+)\b|"
    r"\b(?:in|among)\s+(?:children|adults|pregnant women|older adults|patients aged)\b|"
    r"\b(?:children|adults|patients|participants|subjects)\s+(?:aged|under|over|with)\b|"
    r"\b(?:19|20)\d{2}\s*(?:to|-)\s*(?:19|20)\d{2}\b|初步|可能|尚不清楚|尚未明确|僅限|仅限|"
    r"仅在.{0,12}(?:患者|人群|儿童|成人)|在.{0,12}(?:患者|人群|儿童|成人)中|"
    r"期间|期间内|妊娠期|研究对象|随机试验|对照试验|队列研究|病例对照|报告提示|证据有限|尚无证据",
    re.IGNORECASE,
)
EXACT_TERM_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,}(?:[-/][A-Z0-9]+)*\b|\d[\d,.%/+-]*")
REFERENCE_LIKE_RE = re.compile(r"^\s*\d{1,3}\.\s+[A-Z][A-Za-z-]+(?:\s+[A-Z].*)?$")
SPLIT_WORD_OCR_RE = re.compile(r"\b(?:specif|conf|confirm|diagn|treatm|medicat|investigat)\s+[a-z]{2,}", re.IGNORECASE)
DIRECTIVE_RE = re.compile(r"\b(?:should\s+(?:be\s+)?(?:given|started|stopped|used|administered|treated)|must\s+(?:be\s+)?(?:given|stopped|used)|recommended\s+(?:dose|treatment)|(?:diagnostic|treatment|therapeutic)\s+recommendations?|treatment\s*:|large\s+doses?|first[- ]line\s+(?:therapy|treatment)|treated\s+with|treatment\s+options?|send\s+appropriate\s+cultures|conduct\s+a\s+thorough\s+physical\s+exam|obtain\s+a\s+cbc|avoid\s+a\s+rectal\s+exam)\b", re.IGNORECASE)
PROCEDURE_RE = re.compile(r"\b(?:surgical\s+procedure|operative\s+steps?|incision\s+is\s+made|the\s+procedure\s+first\s+places|implant\s+body\s+below\s+the\s+soft\s+tissue)\b", re.IGNORECASE)
DSM_CODE_TABLE_RE = re.compile(r"numerical\s+listing\s+of\s+DSM[- ]5\s+diagnoses\s+and\s+codes|ICD[- ]10[- ]CM\s+Disorder\.\s+condition", re.IGNORECASE)
ORPHAN_CAPITALS_RE = re.compile(r"\b[A-Z]\s+[A-Z]\s*[.?!]")
REPEATED_WORD_RE = re.compile(r"\b([A-Za-z]{2,})\s+\1\b", re.IGNORECASE)
INCOMPLETE_END_RE = re.compile(r"(?:\b(?:and|or|in|on|at|of|with|for|by|to|as|a|an)\s*|\b\d{1,2}\.\s*)$", re.IGNORECASE)
PROMOTIONAL_CLAIM_RE = re.compile(r"(?:安全性.{0,12}可逆性|可逆.{0,12}(?:矫治|治疗|近视)|(?:高度近视患者的福音|受到.{0,8}青睐)|\d{3,4}\s*度以[上下].{0,24}(?:可治|治疗|矫治))", re.IGNORECASE)
HUIYI_PROFILE_RE = re.compile(r"(?:业务副院长|副院长|主任医师|专科主任|任职|现任|曾任|擅长\s*[:：]|先后在.{0,30}(?:进修|学习深造)|发表论文十余篇|定点医疗机构|医院将始终秉承|慈善医疗众筹)")
HUIYI_MEDICAL_RE = re.compile(r"(?:临床|医学|眼科|疾病|病症|症状|诊断|检查|手术|白内障|青光眼|干眼|近视|眼压|视力|眼底|角膜|眼睑|结膜|虹膜|屈光|视网膜|晶状体|病理|用药|预防|验光|药物)")
MEDICAL_WIKI_TITLES = {"Asthma", "Anatomy"}
HOLDOUT_NO_ANSWER_KINDS = [
    ("medical record number", "病案号", "medical record number"),
    ("date of birth", "出生日期", "date of birth"),
    ("encounter department", "就诊科室", "encounter department"),
    ("encounter identifier", "就诊编号", "encounter identifier"),
    ("clinician name", "接诊医师姓名", "clinician name"),
    ("arrival mode", "到院方式", "arrival mode"),
    ("left-eye visual acuity", "左眼视力", "left-eye visual acuity"),
    ("right-eye visual acuity", "右眼视力", "right-eye visual acuity"),
    ("left-eye pressure measurement", "左眼眼压测量值", "left-eye pressure measurement"),
    ("right-eye pressure measurement", "右眼眼压测量值", "right-eye pressure measurement"),
    ("lens implant model", "人工晶体型号", "lens implant model"),
    ("ocular medication name", "眼科用药名称", "ocular medication name"),
    ("medication administration route", "用药给药途径", "medication administration route"),
    ("prescription dose unit", "处方剂量单位", "prescription dose unit"),
    ("dispensed quantity", "发药数量", "dispensed quantity"),
    ("remaining refill count", "剩余续方次数", "remaining refill count"),
    ("allergy reaction description", "过敏反应描述", "allergy reaction description"),
    ("allergy severity entry", "过敏严重程度记录", "allergy severity entry"),
    ("prior eye surgery date", "既往眼科手术日期", "prior eye surgery date"),
    ("documented eye laterality", "病历记载的眼别", "documented eye laterality"),
    ("OCT central thickness value", "OCT中央厚度数值", "OCT central thickness value"),
    ("visual-field index result", "视野指数检查结果", "visual-field index result"),
    ("test device serial number", "检查设备序列号", "test device serial number"),
    ("imaging acquisition timestamp", "影像采集时间", "imaging acquisition timestamp"),
    ("planned follow-up interval", "计划复诊间隔", "planned follow-up interval"),
    ("referral destination", "转诊去向", "referral destination"),
    ("patient-reported pain score", "患者自述疼痛评分", "patient-reported pain score"),
    ("symptom location entry", "症状部位记录", "symptom location entry"),
    ("symptom duration entry", "症状持续时间记录", "symptom duration entry"),
    ("recorded symptom laterality", "症状记录的侧别", "recorded symptom laterality"),
    ("consent documentation date", "知情同意记录日期", "consent documentation date"),
    ("interpreter language", "使用的翻译语言", "interpreter language"),
    ("preferred pharmacy name", "首选药房名称", "preferred pharmacy name"),
    ("emergency contact relationship", "紧急联系人的关系", "emergency contact relationship"),
    ("contact lens type", "隐形眼镜类型", "contact lens type"),
    ("medication adherence note", "用药依从性记录", "medication adherence note"),
    ("family ocular-history entry", "眼病家族史记录", "family ocular-history entry"),
    ("refraction test timestamp", "屈光检查时间", "refraction test timestamp"),
    ("appointment clinic room", "预约就诊诊室", "appointment clinic room"),
    ("prescription issue date", "处方开具日期", "prescription issue date"),
]

# Category/source targets are frozen before retrieval scoring. Multi-evidence
# questions use two distinct, provenance-checked chunks from one source document.
TARGETS: dict[str, dict[str, dict[str, int]]] = {
    "dev": {
        "semantic": {"textbooks": 6, "statpearls": 7, "pubmed": 3, "huiyi": 3, "wikipedia": 1},
        "exact_term": {"textbooks": 6, "statpearls": 7, "pubmed": 7},
        "bilingual": {"textbooks": 4, "statpearls": 6, "pubmed": 8, "huiyi": 2},
        "multi_hop": {"statpearls": 20},
        "applicability_boundary": {"textbooks": 2, "statpearls": 3, "pubmed": 5},
        "no_answer": {"none": 10},
    },
    "holdout": {
        "semantic": {"textbooks": 7, "statpearls": 11, "pubmed": 7, "huiyi": 4, "wikipedia": 1},
        "exact_term": {"textbooks": 8, "statpearls": 10, "pubmed": 12},
        "bilingual": {"textbooks": 6, "statpearls": 11, "pubmed": 11, "huiyi": 2},
        "multi_hop": {"statpearls": 30},
        "applicability_boundary": {"textbooks": 8, "statpearls": 13, "pubmed": 19},
        "no_answer": {"none": 40},
    },
}


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _stable_key(value: str) -> str:
    return hashlib.sha256(f"h2-quality-v1|{SEED}|{value}".encode("utf-8")).hexdigest()


def _clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if len(text) < 180 or len(text) > 5000 or "\ufffd" in text:
        return None
    if any(text.count(left) != text.count(right) for left, right in (("(", ")"), ("[", "]"))):
        return None
    for index, char in enumerate(text):
        category = unicodedata.category(char)
        if category in {"Co", "Cn", "Cf", "Cs"}:
            return None
        if category.startswith("S") and 0 < index < len(text) - 1 and text[index - 1].isalpha() and text[index + 1].isalpha():
            return None
    if SPLIT_WORD_OCR_RE.search(text) or DIRECTIVE_RE.search(text) or ORPHAN_CAPITALS_RE.search(text):
        return None
    if REPEATED_WORD_RE.search(text) or INCOMPLETE_END_RE.search(text):
        return None
    if PROCEDURE_RE.search(text) or DSM_CODE_TABLE_RE.search(text) or PROMOTIONAL_CLAIM_RE.search(text):
        return None
    if REFERENCE_LIKE_RE.match(text) or len(re.findall(r"\b(?:19|20)\d{2}[;:,]\s*\d", text)) >= 3:
        return None
    if any(unicodedata.category(char) == "Cc" and char not in "\t\n\r" for char in text):
        return None
    if sum(char.isalpha() for char in text) < 100:
        return None
    words = re.findall(r"[A-Za-z]+", text)
    if any(len(word) >= 28 for word in words):
        return None
    single_letter_ratio = sum(len(word) == 1 for word in words) / max(1, len(words))
    if single_letter_ratio > 0.20:
        return None
    return text


def _group_key(source: str, source_document_id: str, title: str) -> str:
    if source == "pubmed":
        # PubMed shard names are transport partitions, not article identities.
        return title
    if source == "wikipedia":
        return title
    return source_document_id


def _eligible_source_content(source: str, content: str) -> bool:
    return source != "huiyi" or (
        not HUIYI_PROFILE_RE.search(content) and bool(HUIYI_MEDICAL_RE.search(content))
    )


def _read_chunk(corpus_root: Path, row: tuple[Any, ...]) -> dict[str, Any] | None:
    document_id, source, source_document_id, chunk_id, rel_path, offset, byte_length, title = row
    if re.search(r"\b(?:references|bibliography|review questions|learning objectives|continuing education activity|objectives|numerical listing|treatment\s*/\s*management|treatment|management|dosage|administration)\b|technique or treatment$", title, re.IGNORECASE):
        return None
    path = corpus_root / rel_path
    with path.open("rb") as stream:
        stream.seek(int(offset))
        raw = stream.read(int(byte_length))
    if len(raw) != int(byte_length):
        return None
    try:
        chunk = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    content = _clean_text(chunk.get("content") or chunk.get("contents"))
    if not content:
        return None
    if not _eligible_source_content(source, content):
        return None
    return {
        "anchorId": document_id,
        "source": source,
        "sourceDocumentId": source_document_id,
        "chunkId": str(chunk_id),
        "title": title,
        "sourcePath": rel_path,
        "sourceByteOffset": int(offset),
        "sourceByteLength": int(byte_length),
        "sourceRecordSha256": sha256(raw),
        "passageSha256": sha256(content.encode("utf-8")),
        "passage": content,
    }


def _group_rows(conn: sqlite3.Connection, source: str, group: str) -> list[tuple[Any, ...]]:
    if source in {"pubmed", "wikipedia"}:
        rows = conn.execute(
            "SELECT document_id,source,source_document_id,chunk_id,path,byte_offset,byte_length,title "
            "FROM sparse_meta WHERE source=? AND title=? ORDER BY CAST(chunk_id AS INTEGER),rowid",
            (source, group),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT document_id,source,source_document_id,chunk_id,path,byte_offset,byte_length,title "
            "FROM sparse_meta WHERE source=? AND source_document_id=? ORDER BY CAST(chunk_id AS INTEGER),rowid",
            (source, group),
        ).fetchall()
    return rows


def _load_groups(conn: sqlite3.Connection) -> dict[str, list[str]]:
    rows = conn.execute(
        "SELECT source,source_document_id,title FROM sparse_meta "
        "GROUP BY source,source_document_id,title"
    )
    groups: dict[str, set[str]] = defaultdict(set)
    for source, source_document_id, title in rows:
        if source == "wikipedia" and title not in MEDICAL_WIKI_TITLES:
            continue
        groups[source].add(_group_key(source, source_document_id, title))
    return {source: sorted(keys, key=lambda key: _stable_key(f"group|{source}|{key}")) for source, keys in groups.items()}


def _split_group(source: str, group: str, textbook_splits: dict[str, str]) -> str:
    if source == "textbooks":
        return textbook_splits[group]
    if source == "wikipedia":
        return "dev" if group == "Asthma" else "holdout"
    value = int(_stable_key(f"split|{source}|{group}")[:8], 16) % 100
    return "dev" if value < 40 else "holdout"


def _target_language(source: str, category: str) -> str:
    source_language = "zh" if source == "huiyi" else "en"
    if category == "bilingual":
        return "en" if source_language == "zh" else "zh"
    return source_language


def _eligible(category: str, anchors: list[dict[str, Any]]) -> bool:
    if category == "exact_term":
        return any(EXACT_TERM_RE.search(anchor["passage"]) for anchor in anchors)
    if category == "applicability_boundary":
        return any(SOURCE_BOUNDARY_RE.search(anchor["passage"]) for anchor in anchors)
    if category == "multi_hop":
        return len(anchors) == 2 and anchors[0]["anchorId"] != anchors[1]["anchorId"]
    return bool(anchors)


def _select_anchor(
    conn: sqlite3.Connection,
    corpus_root: Path,
    source: str,
    category: str,
    split: str,
    groups: list[str],
    use_counts: Counter[tuple[str, str]],
    used_anchor_ids: set[str],
    row_cache: dict[tuple[str, str], list[tuple[Any, ...]]],
    anchor_cache: dict[str, dict[str, Any] | None],
) -> tuple[str, list[dict[str, Any]]]:
    ordered_groups = (
        sorted(groups, key=lambda group: (use_counts[(source, group)], _stable_key(f"pick|{split}|{category}|{source}|{group}")))
        if source in {"textbooks", "huiyi"}
        else groups
    )
    for group in ordered_groups:
        if source not in {"textbooks", "huiyi"} and use_counts[(source, group)] > 0:
            continue
        cache_key = (source, group)
        if cache_key not in row_cache:
            rows = _group_rows(conn, source, group)
            rows.sort(key=lambda row: _stable_key(f"row|{source}|{row[0]}"))
            row_cache[cache_key] = rows
        rows = row_cache[cache_key]
        if source == "textbooks":
            # Books contain thousands of chunks; a deterministic pseudo-random
            # 512-row window is ample for category eligibility and pair search.
            rows = rows[:512]
        good: list[dict[str, Any]] = []
        for row in rows:
            anchor = anchor_cache.get(row[0])
            if row[0] not in anchor_cache:
                anchor = _read_chunk(corpus_root, row)
                anchor_cache[row[0]] = anchor
            if anchor and anchor["anchorId"] not in used_anchor_ids:
                good.append(anchor)
        if category == "multi_hop":
            # Prefer adjacent chunks for a true two-piece evidence requirement.
            pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for index, first in enumerate(good):
                for second in good[index + 1 :]:
                    try:
                        distance = abs(int(first["chunkId"]) - int(second["chunkId"]))
                    except ValueError:
                        distance = 999999
                    if distance <= 2:
                        pairs.append((first, second))
            if not pairs and len(good) >= 2:
                pairs = [(good[0], good[-1])]
            if pairs:
                first, second = min(
                    pairs,
                    key=lambda pair: _stable_key(f"pair|{split}|{pair[0]['anchorId']}|{pair[1]['anchorId']}"),
                )
                selected = [first, second]
            else:
                continue
        else:
            selected = next(([anchor] for anchor in good if _eligible(category, [anchor])), [])
        if not _eligible(category, selected):
            continue
        use_counts[(source, group)] += 1
        used_anchor_ids.update(anchor["anchorId"] for anchor in selected)
        return group, selected
    raise RuntimeError(f"cannot satisfy frozen target split={split} source={source} category={category}")


def _no_answer_questions(split: str, count: int, start: int) -> list[dict[str, Any]]:
    kinds = [
        ("home blood pressure", "居家血压", "home blood pressure"),
        ("documented medication allergy", "药物过敏原", "documented medication allergen"),
        ("current prescription dose", "当前处方剂量", "current prescription dose"),
        ("date of the last follow-up", "最近一次复诊日期", "date of the last follow-up"),
        ("verbatim chief complaint", "主诉原文", "verbatim chief complaint"),
        ("recorded visual acuity", "记录的视力", "recorded visual acuity"),
        ("medication stop date", "停药日期", "medication stop date"),
        ("reported symptom onset date", "症状起始日期", "reported symptom onset date"),
        ("latest intraocular pressure", "最近一次眼压", "latest intraocular pressure"),
        ("next appointment time", "下次预约时间", "next appointment time"),
    ]
    zh_templates = [
        "在合成记录 {patient} 的 {date} 次复诊中，病历记载的{field}是什么？",
        "请从患者 {patient} 的随访记录提取{field}的原始记录值。",
        "合成患者 {patient} 最近一次病历里，{field}被登记为何值？",
        "患者 {patient} 的门诊记录是否写明{field}？具体记录是什么？",
        "只看合成病历 {patient}，该记录的{field}应如何填写？",
    ]
    en_templates = [
        "What does synthetic encounter {patient} record for {field} on {date}?",
        "Retrieve the charted {field} for synthetic patient {patient} from the follow-up record.",
        "Which value is documented for {field} in synthetic chart {patient}?",
        "Does the record for {patient} specify {field}, and if so, what is the entry?",
        "What exact chart entry is shown for {field} for synthetic patient {patient}?",
    ]
    holdout_zh_templates = [
        "合成病历 {patient} 是否记载了{field}？请给出对应的原始条目。",
        "虚构就诊 {patient} 的记录中，{field}登记为何值？",
        "请查找患者 {patient} 病历中的{field}字段并报告记录内容。",
        "仅凭合成患者 {patient} 的就诊档案，能否确认{field}的登记值？",
        "就诊编号 {patient} 的记录把{field}写成什么？",
    ]
    holdout_en_templates = [
        "For synthetic encounter {patient}, what entry is recorded for {field}?",
        "Which chart value is listed for {field} for fictional patient {patient}?",
        "Retrieve the documented {field} from synthetic chart {patient}.",
        "Does the fictional encounter for {patient} include {field}, and what value is entered?",
        "What does the visit record for {patient} show under {field}?",
    ]
    prefix = "D" if split == "dev" else "H"
    output = []
    for offset in range(count):
        ordinal = start + offset
        patient = f"H2-SYN-{prefix}-{ordinal:03d}"
        if split == "holdout":
            field, zh_field, en_field = HOLDOUT_NO_ANSWER_KINDS[offset % len(HOLDOUT_NO_ANSWER_KINDS)]
        else:
            field, zh_field, en_field = kinds[offset % len(kinds)]
        date = f"2026-{(offset % 9) + 1:02d}-{((offset * 7) % 27) + 1:02d}"
        template_index = (offset // 8) % len(zh_templates)
        if offset % 2 == 0:
            templates = holdout_zh_templates if split == "holdout" else zh_templates
            query = templates[template_index].format(patient=patient, date=date, field=zh_field)
        else:
            templates = holdout_en_templates if split == "holdout" else en_templates
            query = templates[template_index].format(patient=patient, date=date, field=en_field)
        output.append({
            "questionId": f"H2-{prefix}-{ordinal:03d}",
            "query": query,
            "language": "zh" if offset % 2 == 0 else "en",
            "taskCategory": "no_answer",
            "corpusVersion": "medtext-local-cc7d43568501e6b7",
            "answerability": "no_answer",
            "answerabilityAdjudicationNote": "The fixed external medical corpus contains no synthetic patient chart or encounter records; this identifier and requested chart fact are fictional.",
            "reviewStatus": "pending",
            "candidatePool": [],
            "qrels": [],
            "annotations": [],
        })
    return output


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    manifest_raw = args.manifest.read_bytes()
    manifest = json.loads(manifest_raw.decode("utf-8"))
    verification = json.loads(args.verification.read_text(encoding="utf-8"))
    manifest_hash = sha256(manifest_raw)
    if verification.get("status") != "verified" or verification.get("manifestSha256") != manifest_hash:
        raise RuntimeError("verified Qwen index does not match the supplied corpus manifest")
    corpus_version = manifest.get("corpusVersion")
    conn = sqlite3.connect(args.sparse_index)
    metadata = {key: json.loads(value) for key, value in conn.execute("SELECT key,value FROM build_metadata")}
    if metadata.get("corpusVersion") != corpus_version or metadata.get("manifestSha256") != manifest_hash:
        raise RuntimeError("sparse index metadata does not match the frozen corpus manifest")

    groups = _load_groups(conn)
    books = groups.get("textbooks", [])
    if len(books) != 18:
        raise RuntimeError(f"expected 18 fixed textbook groups, found {len(books)}")
    sorted_books = sorted(books, key=lambda key: _stable_key(f"book-split|{key}"))
    textbook_splits = {group: ("dev" if index < 6 else "holdout") for index, group in enumerate(sorted_books)}
    if not {"Asthma", "Anatomy"}.issubset(set(groups.get("wikipedia", []))):
        raise RuntimeError("the curated Wikipedia pages used by this protocol are missing")

    use_counts: Counter[tuple[str, str]] = Counter()
    used_anchor_ids: set[str] = set()
    row_cache: dict[tuple[str, str], list[tuple[Any, ...]]] = {}
    anchor_cache: dict[str, dict[str, Any] | None] = {}
    groups_by_split: dict[str, dict[str, list[str]]] = {"dev": defaultdict(list), "holdout": defaultdict(list)}
    for source, source_groups in groups.items():
        for group in source_groups:
            groups_by_split[_split_group(source, group, textbook_splits)][source].append(group)
    datasets: dict[str, dict[str, Any]] = {}
    private_answers: dict[str, Any] = {}
    split_summaries = {}
    for split in ("dev", "holdout"):
        prefix = "D" if split == "dev" else "H"
        questions: list[dict[str, Any]] = []
        anchors_by_question: list[dict[str, Any]] = []
        category_counts: Counter[str] = Counter()
        source_counts: Counter[str] = Counter()
        ordinal = 1
        no_answer_count = TARGETS[split]["no_answer"]["none"]
        for category in ("semantic", "exact_term", "bilingual", "multi_hop", "applicability_boundary"):
            for source, count in TARGETS[split][category].items():
                for _ in range(count):
                    group, anchors = _select_anchor(
                        conn,
                        args.corpus_root,
                        source,
                        category,
                        split,
                        groups_by_split[split][source],
                        use_counts,
                        used_anchor_ids,
                        row_cache,
                        anchor_cache,
                    )
                    question_id = f"H2-{prefix}-{ordinal:03d}"
                    ordinal += 1
                    target_language = _target_language(source, category)
                    normalized_category = {
                        "semantic": "semantic",
                        "exact_term": "exact_term",
                        "bilingual": "bilingual",
                        "multi_hop": "multi_hop",
                        "applicability_boundary": "applicability_boundary",
                    }[category]
                    questions.append({
                        "questionId": question_id,
                        "query": f"[GENERATE:{category}]",
                        "language": target_language,
                        "taskCategory": normalized_category,
                        "corpusVersion": corpus_version,
                        "answerability": "answerable",
                        "answerabilityAdjudicationNote": "Question must be answerable from the exact frozen source anchor(s); generated wording is machine-checked against verbatim anchor quotes.",
                        "reviewStatus": "pending",
                        "candidatePool": [],
                        "qrels": [],
                        "annotations": [],
                    })
                    anchors_by_question.append({
                        "questionId": question_id,
                        "split": split,
                        "requestedCategory": category,
                        "targetLanguage": target_language,
                        "sourceGroup": group,
                        "anchors": anchors,
                    })
                    category_counts[category] += 1
                    source_counts[source] += 1

        no_answers = _no_answer_questions(split, no_answer_count, ordinal)
        for item in no_answers:
            item["corpusVersion"] = corpus_version
        questions.extend(no_answers)
        for item in no_answers:
            category_counts["no_answer"] += 1

        expected_count = 100 if split == "dev" else 200
        if len(questions) != expected_count:
            raise RuntimeError(f"{split} target produced {len(questions)} questions, expected {expected_count}")
        dataset_id = f"h2-quality-v11-{split}-20261015"
        datasets[split] = {
            "schemaVersion": "huiyi-rag-retrieval-dataset/v1",
            "datasetId": dataset_id,
            "split": split,
            "corpusVersion": corpus_version,
            "annotationProtocolVersion": "h2-quality-llm-judge-v2",
            "questions": questions,
        }
        private_answers[split] = anchors_by_question
        split_summaries[split] = {
            "questionCount": len(questions),
            "answerableCount": len(questions) - no_answer_count,
            "noAnswerCount": no_answer_count,
            "categoryCounts": dict(category_counts),
            "sourceCounts": dict(source_counts),
            "textbookGroups": sorted(group for group, assigned in textbook_splits.items() if assigned == split),
        }

    conn.close()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for split, dataset in datasets.items():
        out = args.out_dir / f"dataset-{split}-draft.json"
        out.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        anchor_out = args.out_dir / f"anchors-{split}-private.json"
        anchor_out.write_text(json.dumps({
            "schemaVersion": "h2-private-source-anchor-manifest/v1",
            "datasetId": dataset["datasetId"],
            "corpusVersion": corpus_version,
            "manifestSha256": manifest_hash,
            "selectionSeed": SEED,
            "questions": private_answers[split],
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return {
        "schemaVersion": "h2-quality-anchor-preparation/v1",
        "status": "source_anchors_prepared_pending_question_generation",
        "corpusVersion": corpus_version,
        "manifestSha256": manifest_hash,
        "sparseIndexMetadata": metadata,
        "selectionSeed": SEED,
        "splitGroupIsolation": "source document groups are disjoint; PubMed groups use article title rather than shard; textbooks are assigned by whole book; Wiki uses one curated page in HOLDOUT only",
        "summaries": split_summaries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--verification", type=Path, required=True)
    parser.add_argument("--sparse-index", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    result = prepare(args)
    summary_path = args.out_dir / "anchor-preparation-summary.json"
    summary_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "summaries": result["summaries"], "summaryPath": str(summary_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
