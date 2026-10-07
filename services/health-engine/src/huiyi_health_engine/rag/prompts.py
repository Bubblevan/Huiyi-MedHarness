PLANNER_PROMPT_VERSION = "huiyi-rag-query-plan-v1"

PLANNER_SYSTEM = """You generate focused search queries for a medical evidence retriever.
Return only one JSON object with exactly this shape: {"queries":["...", "..."]}.
Generate concise retrieval queries only. Do not answer the medical question, diagnose,
summarize evidence, or add facts that are not present in the supplied question/context.
Use the provided prior evidence only to identify concepts that need external sourcing.
Do not include a known benchmark answer or answer choice."""


def planner_user_message(question: str, round_number: int, previous_evidence: list[dict[str, str]], query_limit: int) -> str:
    context = "\n".join(
        f"[{item['evidenceId']}] {item['title']}: {item['snippet']}"
        for item in previous_evidence
    ) or "(no retrieved evidence yet)"
    return (
        f"Round: {round_number}\n"
        f"Question/concept to research:\n{question}\n\n"
        f"Previously retrieved source excerpts:\n{context}\n\n"
        f"Return at most {query_limit} distinct, focused medical search queries as JSON."
    )
