"""Frozen strict parser for MedQA benchmark answer outputs."""

from __future__ import annotations

import json
import re


WHOLE_CHOICE = re.compile(r"^[ABCD]$")


def parse_choice(raw: str) -> tuple[str | None, str]:
    text = raw.strip()
    if WHOLE_CHOICE.fullmatch(text):
        return text, "bare_choice"

    # Qwen3 may wrap its JSON in a code fence or expose a <think> block even
    # when the local deployment disables hidden thinking. Remove only these
    # known wrappers; do not infer an option from free-form prose.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text)
    decoder = json.JSONDecoder()
    for candidate in candidates:
        for index, character in enumerate(candidate):
            if character != "{":
                continue
            try:
                value, _end = decoder.raw_decode(candidate[index:])
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            answer = value.get("answer", value.get("answer_choice"))
            if isinstance(answer, str):
                normalized = answer.strip().upper()
                if WHOLE_CHOICE.fullmatch(normalized):
                    return normalized, "json_choice"
                leading_choice = re.match(r"^([ABCD])(?=$|[.)\s:])", normalized)
                if leading_choice:
                    return leading_choice.group(1), "json_choice_with_option_text"
    return None, "parse_failure"
