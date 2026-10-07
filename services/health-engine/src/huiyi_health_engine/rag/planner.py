from __future__ import annotations

import json
import time
from dataclasses import dataclass

import requests

from .config import RagSettings
from .prompts import PLANNER_PROMPT_VERSION, PLANNER_SYSTEM, planner_user_message


class PlannerError(RuntimeError):
    pass


@dataclass(frozen=True)
class QueryPlan:
    queries: list[str]
    model: str
    prompt_version: str
    latency_ms: float
    input_tokens: int | None = None
    output_tokens: int | None = None


class QueryPlanner:
    def __init__(self, settings: RagSettings, http: requests.Session | None = None):
        self.settings = settings
        self.http = http or requests.Session()

    def plan(
        self,
        question: str,
        round_number: int,
        previous_evidence: list[dict[str, str]],
        timeout_seconds: float | None = None,
    ) -> QueryPlan:
        started = time.perf_counter()
        try:
            response = self.http.post(
                self.settings.planner_url,
                headers={
                    "authorization": f"Bearer {self.settings.planner_api_key}",
                    "content-type": "application/json",
                },
                json={
                    "model": self.settings.planner_model,
                    "temperature": 0,
                    "max_tokens": self.settings.planner_max_tokens,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": PLANNER_SYSTEM},
                        {"role": "user", "content": planner_user_message(
                            question,
                            round_number,
                            previous_evidence,
                            self.settings.max_queries_per_round,
                        )},
                    ],
                },
                timeout=(5, max(0.1, min(self.settings.planner_timeout_seconds, timeout_seconds or self.settings.planner_timeout_seconds))),
            )
            response.raise_for_status()
            body = response.json()
            content = body["choices"][0]["message"]["content"]
            queries = parse_query_plan(content, self.settings.max_queries_per_round)
            usage = body.get("usage") if isinstance(body, dict) else None
        except Exception as exc:
            if isinstance(exc, PlannerError):
                raise
            raise PlannerError(type(exc).__name__) from None
        return QueryPlan(
            queries=queries,
            model=self.settings.planner_model,
            prompt_version=PLANNER_PROMPT_VERSION,
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
            input_tokens=_usage_count(usage, "prompt_tokens"),
            output_tokens=_usage_count(usage, "completion_tokens"),
        )


def parse_query_plan(value: object, maximum: int) -> list[str]:
    if not isinstance(value, str):
        raise PlannerError("MalformedPlan")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        raise PlannerError("MalformedPlan") from None
    if not isinstance(parsed, dict) or set(parsed) != {"queries"} or not isinstance(parsed["queries"], list):
        raise PlannerError("MalformedPlan")
    queries: list[str] = []
    seen: set[str] = set()
    for item in parsed["queries"]:
        if not isinstance(item, str):
            raise PlannerError("MalformedPlan")
        query = " ".join(item.split())
        if not query or len(query) > 1000:
            raise PlannerError("MalformedPlan")
        key = query.casefold()
        if key not in seen:
            seen.add(key)
            queries.append(query)
        if len(queries) > maximum:
            raise PlannerError("MalformedPlan")
    if not queries:
        raise PlannerError("MalformedPlan")
    return queries


def _usage_count(value: object, key: str) -> int | None:
    if not isinstance(value, dict):
        return None
    count = value.get(key)
    return count if isinstance(count, int) and count >= 0 else None
