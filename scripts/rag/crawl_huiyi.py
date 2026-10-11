#!/usr/bin/env python3
"""Crawl the public Huiyi Eye Hospital site into an auditable local corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, Tag
from transformers import AutoTokenizer


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_ROOT = (
    REPOSITORY_ROOT
    / "services"
    / "health-engine"
    / "data"
    / "local-rag-hc-rag-002"
    / "corpus"
    / "huiyi"
)
BASE_URL = "https://yk.huiyi9e.com/"
ALLOWED_HOST = "yk.huiyi9e.com"
PARSER_VERSION = "huiyi-html-v2"
SCHEMA_VERSION = "huiyi-canonical-v1"
DEFAULT_USER_AGENT = (
    "HuiyiMedHarnessCrawler/1.0 "
    "(+local public-institutional-knowledge snapshot; contact: webmaster@huiyi9e.com)"
)

# These are discovery pages. The crawler follows only the same site's explicitly
# classified paths below; it never follows arbitrary links or downloads assets.
SEED_PATHS = (
    "/",
    "/about.htm",
    "/about/yyjs.htm",
    "/about/zhici.htm",
    "/about/lingdao.htm",
    "/about/zizhi.htm",
    "/about/wenhua.htm",
    "/about/rongyu.htm",
    "/zhuanjia.htm",
    "/keshi.htm",
    "/jiangtang/aiyan_kepu.htm",
    "/jiangtang/zixun_dayi.htm",
    "/Service.htm",
    "/Service/flowpath.htm",
    "/Service/line.htm",
    "/news/yaowen.htm",
    "/Service/zhuanjiamz.htm",
    "/Service/fixedpoint.htm",
    "/Service/reserve.htm",
)

DYNAMIC_SERVICE_PATHS = {
    "/service/zhuanjiamz.htm",
    "/service/fixedpoint.htm",
    "/service/reserve.htm",
}
DYNAMIC_TEXT = re.compile(
    r"今日|本周|本月|近期|节假日|国庆|春节|临时|活动安排|报名通道|门诊排班|预约挂号|专家门诊",
    re.I,
)
DATE_PATTERN = re.compile(r"(?<!\d)(20\d{2})[-./年](\d{1,2})[-./月](\d{1,2})日?(?!\d)")
DATE_RANGE_PATTERN = re.compile(
    r"20\d{2}[-./年]\d{1,2}[-./月]\d{1,2}日?\s*(?:至|到|—|–|~|～|-|至)\s*(?:20\d{2}[-./年])?\d{1,2}[-./月]\d{1,2}日?"
)
BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd"}
DROP_SELECTORS = (
    "script",
    "style",
    "noscript",
    "iframe",
    # The hospital CMS wraps some article bodies (notably doctor profiles) in
    # a <form> element. Remove interactive controls, but preserve the wrapper
    # and its readable article text.
    "input",
    "button",
    "select",
    "textarea",
    "nav",
    "header",
    "footer",
    "aside",
    ".breadcrumb",
    ".position",
    ".share",
    ".recommend",
    ".recommend_news",
    ".pagination",
    ".page_turn",
    ".qrcode",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def normalize_url(base: str, href: str) -> str | None:
    absolute = urljoin(base, href.strip())
    absolute, _fragment = urldefrag(absolute)
    parts = urlsplit(absolute)
    if parts.scheme not in {"http", "https"} or (parts.hostname or "").lower() != ALLOWED_HOST:
        return None
    if parts.username or parts.password:
        return None
    # Tracking/query parameters are not needed for this static HTML corpus.
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    return urlunsplit(("https", ALLOWED_HOST, path, "", ""))


def classify_url(url: str) -> tuple[str, str, bool] | None:
    """Return (document type, ingestion policy, canonical-document flag)."""
    path = urlsplit(url).path.lower()
    if path in {"/", "/about.htm", "/zhuanjia.htm", "/keshi.htm", "/service.htm"}:
        return ("discovery_page", "discovery_only", False)
    if path.startswith("/jiangtang/"):
        return ("discovery_page", "discovery_only", False)
    if path.startswith("/news/") or path == "/news.htm" or path.startswith("/info/1019/"):
        return ("event_news", "raw_only_dynamic", False)
    if path in DYNAMIC_SERVICE_PATHS:
        return ("operational_service", "raw_only_dynamic", False)
    if path.startswith("/about/") or path.startswith("/info/1012/"):
        return ("hospital_info", "canonical", True)
    if path.startswith("/info/1021/"):
        return ("doctor_profile", "canonical", True)
    if path.startswith("/info/1022/"):
        return ("department", "canonical", True)
    if path.startswith("/info/1024/"):
        return ("patient_education", "canonical", True)
    if path.startswith("/info/1025/"):
        return ("faq", "canonical", True)
    if path in {"/service/flowpath.htm", "/service/line.htm"}:
        return ("hospital_service_info", "canonical", True)
    return None


def clean_text(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    return re.sub(r"\s+", " ", text).strip()


def canonical_body(soup: BeautifulSoup) -> tuple[str, Tag | None]:
    for selector in DROP_SELECTORS:
        for node in soup.select(selector):
            node.decompose()
    candidates = (
        "main.article_body .main_body",
        "main.article_body .v_news_content",
        ".article_body .main_body",
        ".v_news_content",
        "main",
        "article",
        ".main_body",
        ".content",
    )
    for selector in candidates:
        node = soup.select_one(selector)
        if node and len(clean_text(node.get_text(" ", strip=True))) >= 80:
            return selector, node
    body = soup.body
    return "body", body


def primary_text(soup: BeautifulSoup) -> str:
    for selector in (
        "main.article_body .main_body",
        "main.article_body .v_news_content",
        ".article_body .main_body",
        ".v_news_content",
        "main",
        "article",
        ".main_body",
        ".content",
    ):
        node = soup.select_one(selector)
        if node:
            text = clean_text(node.get_text(" ", strip=True))
            if len(text) >= 40:
                return text
    return clean_text(soup.body.get_text(" ", strip=True) if soup.body else soup.get_text(" ", strip=True))


def page_title(soup: BeautifulSoup) -> str:
    for selector in (".main_title", "h1", "h2"):
        node = soup.select_one(selector)
        if node:
            value = clean_text(node.get_text(" ", strip=True))
            if value and value.lower() != "logo":
                return value
    if soup.title:
        value = clean_text(soup.title.get_text(" ", strip=True))
        return re.split(r"\s*[-|｜]\s*恩施慧宜眼科医院", value, maxsplit=1)[0].strip()
    return ""


def published_date(text: str) -> str | None:
    match = DATE_PATTERN.search(text)
    if not match:
        return None
    year, month, day = map(int, match.groups())
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None


def semantic_units(body: Tag) -> list[tuple[tuple[str, ...], str]]:
    units: list[tuple[tuple[str, ...], str]] = []
    headings: list[str | None] = [None] * 6
    for element in body.find_all(list(BLOCK_TAGS)):
        # Avoid emitting nested paragraph text twice when it sits inside a list item.
        parent = element.parent
        nested = False
        while isinstance(parent, Tag) and parent is not body:
            if parent.name in BLOCK_TAGS:
                nested = True
                break
            parent = parent.parent
        if nested:
            continue
        text = clean_text(element.get_text(" ", strip=True))
        if not text:
            continue
        if element.name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            level = int(element.name[1]) - 1
            headings[level] = text
            for index in range(level + 1, len(headings)):
                headings[index] = None
            continue
        section = tuple(item for item in headings if item)
        units.append((section, text))
    if units:
        return units
    for line in body.get_text("\n", strip=True).splitlines():
        text = clean_text(line)
        if text:
            units.append(((), text))
    return units


def token_count(tokenizer: object, title: str, content: str) -> int:
    encoded = tokenizer(title, content, add_special_tokens=True, truncation=False, return_attention_mask=False)
    return len(encoded["input_ids"])


def split_to_budget(text: str, tokenizer: object, title: str, section: tuple[str, ...], budget: int) -> list[str]:
    prefix = "\n".join(section)
    chunks: list[str] = []
    remaining = text
    while remaining:
        low, high = 1, len(remaining)
        best = 0
        while low <= high:
            middle = (low + high) // 2
            candidate = remaining[:middle]
            content = f"{prefix}\n{candidate}" if prefix else candidate
            if token_count(tokenizer, title, content) <= budget:
                best = middle
                low = middle + 1
            else:
                high = middle - 1
        if best == 0:
            best = min(200, len(remaining))
        if best < len(remaining):
            boundary = max(remaining.rfind(mark, 0, best) for mark in "。！？!?；;，, ")
            if boundary >= max(1, best // 2):
                best = boundary + 1
        chunks.append(remaining[:best].strip())
        remaining = remaining[best:].strip()
    return [chunk for chunk in chunks if chunk]


def make_chunks(
    document: dict[str, object],
    units: list[tuple[tuple[str, ...], str]],
    tokenizer: object,
    budget: int,
) -> list[dict[str, object]]:
    title = str(document["title"])
    groups: list[tuple[tuple[str, ...], list[str]]] = []
    for section, text in units:
        pieces = [text]
        candidate_content = "\n".join((*section, text))
        if token_count(tokenizer, title, candidate_content) > budget:
            pieces = split_to_budget(text, tokenizer, title, section, budget)
        for piece in pieces:
            if not groups or groups[-1][0] != section:
                groups.append((section, []))
            current = groups[-1][1]
            candidate = "\n".join((*section, *current, piece))
            if current and token_count(tokenizer, title, candidate) > budget:
                groups.append((section, [piece]))
            else:
                current.append(piece)

    rows: list[dict[str, object]] = []
    for ordinal, (section, paragraphs) in enumerate(groups):
        content_parts = [*section, *paragraphs]
        content = "\n".join(part for part in content_parts if part).strip()
        if not content:
            continue
        content_hash = sha256_text(content)
        chunk_id = f"{document['document_id']}-{ordinal:04d}-{content_hash[:12]}"
        rows.append({
            "chunk_id": chunk_id,
            "document_id": document["document_id"],
            "source_id": document["source_id"],
            "document_type": document["document_type"],
            "department": document.get("department"),
            "topic": document.get("topic"),
            "title": title,
            "section_path": list(section),
            "text": content,
            "content": content,
            "ordinal": len(rows),
            "token_count": token_count(tokenizer, title, content),
            "content_sha256": content_hash,
            "review_status": document["review_status"],
            "freshness_class": document["freshness_class"],
            "source_url": document["source_url"],
            "sourceUri": document["source_url"],
        })
    return rows


def is_stale_text(text: str, published_at: str | None) -> bool:
    if DYNAMIC_TEXT.search(text):
        return True
    if published_at:
        try:
            return (datetime.now(timezone.utc).date() - datetime.fromisoformat(published_at).date()).days > 365 * 3
        except ValueError:
            return False
    return False


def is_dynamic_text(text: str) -> bool:
    return bool(DYNAMIC_TEXT.search(text) or DATE_RANGE_PATTERN.search(text))


def simhash64(text: str) -> int:
    tokens = re.findall(r"[\u3400-\u9fff]|[a-zA-Z0-9]+", text.lower())
    if len(tokens) < 4:
        shingles = tokens
    else:
        shingles = ["\x1f".join(tokens[index : index + 4]) for index in range(len(tokens) - 3)]
    weights = [0] * 64
    for shingle in shingles:
        value = int.from_bytes(hashlib.sha256(shingle.encode("utf-8")).digest()[:8], "big")
        for bit in range(64):
            weights[bit] += 1 if value & (1 << bit) else -1
    return sum(1 << bit for bit, weight in enumerate(weights) if weight >= 0)


def near_duplicate_flags(documents: list[dict[str, object]]) -> list[dict[str, object]]:
    candidates = [doc for doc in documents if len(str(doc.get("content", ""))) >= 120]
    signatures = [simhash64(str(doc["content"])) for doc in candidates]
    flags: list[dict[str, object]] = []
    for left in range(len(candidates)):
        left_text = str(candidates[left]["content"])
        for right in range(left + 1, len(candidates)):
            right_text = str(candidates[right]["content"])
            if min(len(left_text), len(right_text)) / max(len(left_text), len(right_text)) < 0.8:
                continue
            distance = (signatures[left] ^ signatures[right]).bit_count()
            if distance <= 3:
                flags.append({
                    "source_url": candidates[left]["source_url"],
                    "near_duplicate_of": candidates[right]["source_url"],
                    "simhash_hamming_distance": distance,
                    "action": "flag_only",
                })
    return flags


def make_document(url: str, document_type: str, fetched_at: str, soup: BeautifulSoup) -> tuple[dict[str, object] | None, list[tuple[tuple[str, ...], str]], str | None]:
    title = page_title(soup)
    selector, body = canonical_body(soup)
    if body is None:
        return None, [], "no_extractable_body"
    full_text = clean_text(body.get_text(" ", strip=True))
    if len(full_text) < 40 or not title:
        return None, [], "empty_or_short_content"
    units = semantic_units(body)
    content = "\n".join(text for _section, text in units)
    content_hash = sha256_text(content)
    published_at = published_date(full_text)
    stale = is_stale_text(full_text, published_at)
    education = document_type in {"patient_education", "faq"}
    source_id = "huiyi-source-" + sha256_text(url)[:20]
    document_id = "huiyi-doc-" + sha256_text(url)[:20]
    document = {
        "document_id": document_id,
        "source_id": source_id,
        "source_family": "huiyi_official",
        "source_url": url,
        "document_type": document_type,
        "department": None,
        "topic": title,
        "title": title,
        "content": content,
        "published_at": published_at,
        "effective_from": None,
        "effective_until": None,
        "fetched_at": fetched_at,
        "review_status": "NEEDS_HUMAN_REVIEW" if education else "AUTO_ACCEPTED_PUBLIC_INFO",
        "ingestion_policy": "canonical",
        "raw_sha256": None,
        "content_sha256": content_hash,
        "schema_version": SCHEMA_VERSION,
        "freshness_class": "POTENTIALLY_STALE" if stale else ("STATIC_EDUCATION" if education else "STATIC_PROFILE"),
        "extractor": selector,
    }
    return document, units, None


def fetch(client: httpx.Client, url: str, delay: float, retries: int) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        if delay > 0:
            time.sleep(delay)
        try:
            response = client.get(url)
            if response.status_code < 500 or attempt == retries:
                return response
            last_error = RuntimeError(f"HTTP {response.status_code}")
        except httpx.HTTPError as exc:
            last_error = exc
            if attempt == retries:
                raise
        time.sleep(min(2**attempt, 8))
    assert last_error is not None
    raise last_error


def crawl(args: argparse.Namespace) -> dict[str, object]:
    output_root: Path = args.output_root.resolve()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    raw_run_root = output_root / "raw" / "runs" / run_id
    pages_root = raw_run_root / "pages"
    raw_run_root.mkdir(parents=True, exist_ok=True)
    normalized_run_root = output_root / "normalized" / "runs" / run_id
    chunks_run_root = output_root / "chunk" / "runs" / run_id
    aggregate_chunks_root = output_root / "chunks" / "runs" / run_id

    tokenizer_path = args.tokenizer_path.resolve()
    if not tokenizer_path.is_dir():
        raise SystemExit(f"local MedCPT tokenizer is missing: {tokenizer_path}")
    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)

    user_agent = args.user_agent
    headers = {"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml"}
    client = httpx.Client(headers=headers, follow_redirects=True, timeout=args.timeout)
    robots_url = urljoin(BASE_URL, "/robots.txt")
    robots_status: int | None = None
    try:
        robots_response = fetch(client, robots_url, 0, args.retries)
        robots_status = robots_response.status_code
    except httpx.HTTPError:
        robots_status = None

    queue: deque[tuple[str, int]] = deque()
    seen: set[str] = set()
    for path in SEED_PATHS:
        normalized = normalize_url(BASE_URL, path)
        if normalized:
            queue.append((normalized, 0))
    raw_manifest: list[dict[str, object]] = []
    canonical_sources: list[tuple[dict[str, object], list[tuple[tuple[str, ...], str]]]] = []
    rejected: list[dict[str, object]] = []
    failures: list[dict[str, object]] = []
    seen_content: dict[str, str] = {}
    exact_duplicates: list[dict[str, str]] = []

    while queue and len(seen) < args.max_pages:
        url, depth = queue.popleft()
        if url in seen or depth > args.max_depth:
            continue
        classification = classify_url(url)
        if not classification:
            continue
        seen.add(url)
        document_type, policy, canonical = classification
        try:
            response = fetch(client, url, args.delay, args.retries)
        except httpx.HTTPError as exc:
            failures.append({"url": url, "error": type(exc).__name__, "message": str(exc)[:300]})
            continue
        final_url = normalize_url(str(response.url), str(response.url))
        content_type = response.headers.get("content-type", "")
        if final_url is None or response.status_code != 200 or "html" not in content_type.lower():
            failures.append({"url": url, "status": response.status_code, "contentType": content_type, "finalUrl": str(response.url)})
            continue
        raw = response.content
        source_id = "huiyi-source-" + sha256_text(url)[:20]
        raw_path = Path("raw") / "runs" / run_id / "pages" / f"{source_id}.html"
        raw_file = output_root / raw_path
        raw_file.parent.mkdir(parents=True, exist_ok=True)
        raw_file.write_bytes(raw)
        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        raw_manifest.append({
            "source_id": source_id,
            "url": url,
            "final_url": final_url,
            "http_status": response.status_code,
            "fetched_at_utc": fetched_at,
            "content_type": content_type,
            "raw_path": raw_path.as_posix(),
            "raw_sha256": sha256_bytes(raw),
            "parser_version": PARSER_VERSION,
            "ingestion_policy": policy,
            "document_type": document_type,
        })
        print(f"[{len(raw_manifest)}] {policy} {url} ({len(raw)} bytes)", flush=True)
        try:
            html = raw.decode(response.encoding or "utf-8", errors="replace")
            soup = BeautifulSoup(html, "html.parser")
        except Exception as exc:
            failures.append({"url": url, "error": type(exc).__name__, "message": "HTML parse failed"})
            continue

        if policy == "canonical" and is_dynamic_text(primary_text(soup)):
            policy = "raw_only_dynamic"
            document_type = "temporary_notice"
            canonical = False
            raw_manifest[-1]["ingestion_policy"] = policy
            raw_manifest[-1]["document_type"] = document_type

        if canonical:
            document, units, rejection_reason = make_document(url, document_type, fetched_at, soup)
            if document is None:
                rejected.append({"source_id": source_id, "source_url": url, "reason": rejection_reason})
            else:
                document["raw_sha256"] = sha256_bytes(raw)
                content_hash = str(document["content_sha256"])
                if content_hash in seen_content:
                    exact_duplicates.append({"source_url": url, "duplicate_of": seen_content[content_hash], "content_sha256": content_hash})
                else:
                    seen_content[content_hash] = url
                    canonical_sources.append((document, units))

        if depth >= args.max_depth or policy == "raw_only_dynamic":
            continue
        links = set()
        for anchor in soup.select("a[href]"):
            target = normalize_url(final_url, str(anchor.get("href", "")))
            if target and target not in seen and classify_url(target):
                links.add(target)
        for target in sorted(links):
            queue.append((target, depth + 1))

    client.close()

    normalized_run_root.mkdir(parents=True, exist_ok=True)
    chunks_run_root.mkdir(parents=True, exist_ok=True)
    aggregate_chunks_root.mkdir(parents=True, exist_ok=True)

    documents: list[dict[str, object]] = []
    all_chunks: list[dict[str, object]] = []
    chunk_count = 0
    chunk_file_hashes: list[dict[str, object]] = []
    for document, units in canonical_sources:
        document_id = str(document["document_id"])
        rows = make_chunks(document, units, tokenizer, args.max_chunk_tokens)
        if not rows:
            rejected.append({"source_id": document["source_id"], "source_url": document["source_url"], "reason": "no_chunks"})
            continue
        chunk_path = chunks_run_root / f"{document_id}.jsonl"
        write_jsonl(chunk_path, rows)
        all_chunks.extend(rows)
        chunk_count += len(rows)
        chunk_file_hashes.append({"path": chunk_path.relative_to(output_root).as_posix(), "sha256": sha256_bytes(chunk_path.read_bytes()), "chunk_count": len(rows)})
        documents.append(document)

    near_duplicates = near_duplicate_flags(documents)

    raw_manifest_path = raw_run_root / "manifest.jsonl"
    write_jsonl(raw_manifest_path, raw_manifest)
    write_jsonl(normalized_run_root / "documents.jsonl", documents)
    write_jsonl(normalized_run_root / "rejected.jsonl", rejected)
    write_jsonl(aggregate_chunks_root / "chunks.jsonl", all_chunks)

    source_catalog = {
        "schemaVersion": 1,
        "sourceFamily": "huiyi_official",
        "baseUrl": BASE_URL,
        "allowedHost": ALLOWED_HOST,
        "seedPaths": list(SEED_PATHS),
        "crawlScope": {
            "canonical": ["hospital_info", "doctor_profile", "department", "patient_education", "faq", "hospital_service_info"],
            "rawOnlyDynamic": ["news/events", "temporary notices", "clinic schedules", "registration", "insurance service pages"],
            "robotsTxtStatus": robots_status,
            "maxPages": args.max_pages,
            "maxDepth": args.max_depth,
            "delaySeconds": args.delay,
            "sameHostOnly": True,
            "followsForms": False,
            "downloadsNonHtmlAssets": False,
        },
        "userAgent": user_agent,
    }
    catalog_path = output_root / "source_catalog.json"
    if not catalog_path.exists():
        write_json(catalog_path, source_catalog)
    write_json(normalized_run_root / "manifest.json", {
        "schemaVersion": 1,
        "runId": run_id,
        "sourceCatalogPath": "source_catalog.json",
        "rawManifestPath": raw_manifest_path.relative_to(output_root).as_posix(),
        "documentsPath": (normalized_run_root / "documents.jsonl").relative_to(output_root).as_posix(),
        "rejectedPath": (normalized_run_root / "rejected.jsonl").relative_to(output_root).as_posix(),
        "documentCount": len(documents),
        "rejectedCount": len(rejected),
        "exactDuplicateCount": len(exact_duplicates),
        "exactDuplicates": exact_duplicates,
        "nearDuplicateFlagCount": len(near_duplicates),
        "nearDuplicateFlags": near_duplicates,
        "failures": failures,
        "rawPageCount": len(raw_manifest),
        "policyCounts": dict(Counter(str(row["ingestion_policy"]) for row in raw_manifest)),
        "documentTypeCounts": dict(Counter(str(row["document_type"]) for row in documents)),
    })
    write_json(chunks_run_root / "manifest.json", {
        "schemaVersion": 1,
        "runId": run_id,
        "documentCount": len(documents),
        "chunkCount": chunk_count,
        "maxChunkTokens": args.max_chunk_tokens,
        "tokenizerPath": str(tokenizer_path),
        "chunkFiles": chunk_file_hashes,
    })
    report = {
        "status": "complete" if not queue else "page_limit_reached",
        "runId": run_id,
        "outputRoot": str(output_root),
        "rawPageCount": len(raw_manifest),
        "canonicalDocumentCount": len(documents),
        "chunkCount": chunk_count,
        "rejectedCount": len(rejected),
        "exactDuplicateCount": len(exact_duplicates),
        "failureCount": len(failures),
        "pendingQueueAtLimit": len(queue),
        "robotsTxtStatus": robots_status,
        "rawManifest": str(raw_manifest_path),
        "normalizationManifest": str(normalized_run_root / "manifest.json"),
        "chunkRoot": str(chunks_run_root),
        "chunkManifest": str(chunks_run_root / "manifest.json"),
        "aggregateChunks": str(aggregate_chunks_root / "chunks.jsonl"),
    }
    run_report = output_root / "crawl-runs" / run_id / "report.json"
    write_json(run_report, report)
    write_json(output_root / "crawl-report.json", report)
    write_json(normalized_run_root / "dedup-report.json", {
        "exactDuplicateCount": len(exact_duplicates),
        "exactDuplicates": exact_duplicates,
        "nearDuplicateFlagCount": len(near_duplicates),
        "nearDuplicateFlags": near_duplicates,
        "nearDuplicatesRemoved": 0,
    })
    write_json(output_root / "active-run.json", {
        "runId": run_id,
        "rawManifest": raw_manifest_path.relative_to(output_root).as_posix(),
        "normalizationManifest": (normalized_run_root / "manifest.json").relative_to(output_root).as_posix(),
        "chunkRoot": chunks_run_root.relative_to(output_root).as_posix(),
        "chunkManifest": (chunks_run_root / "manifest.json").relative_to(output_root).as_posix(),
        "report": run_report.relative_to(output_root).as_posix(),
    })
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--tokenizer-path", type=Path, default=Path(r"E:\Health-Copilot-Models\models\MedCPT-Article-Encoder"))
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument("--max-pages", type=int, default=500)
    parser.add_argument("--max-depth", type=int, default=5)
    parser.add_argument("--max-chunk-tokens", type=int, default=450)
    parser.add_argument("--delay", type=float, default=0.8)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--retries", type=int, default=2)
    args = parser.parse_args()
    if args.max_pages < 1 or args.max_depth < 0 or args.max_chunk_tokens < 64:
        parser.error("page count, depth, or chunk token budget is invalid")
    report = crawl(args)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
