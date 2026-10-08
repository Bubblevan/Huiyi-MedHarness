"""Prompt text copied from pinned MedRAG src/template.py (7599a728)."""

PROMPT_VERSION = "medrag-7599a728a28789fd601728c08d313b1148051f41"

I_MEDRAG_SYSTEM = (
    "You are a helpful medical assistant, and your task is to answer the given "
    "question following the instructions given by the user. "
)

FOLLOW_UP_INSTRUCTION_ASK = (
    "Please first analyze all the information in a section named Analysis (## Analysis). "
    "Then, use key terms from previous answers to form specific and direct questions. "
    "Generate {} concise, context-specific queries to search for additional information "
    "in an external knowledge base, in a section named Queries (## Queries). Each query "
    "should be simple and focused, directly relating to the key terms used in the answers. "
    "Wait for responses from the user before proceeding."
)

FOLLOW_UP_INSTRUCTION_ANSWER = (
    "Please first think step-by-step to analyze all the information in a section named "
    "Analysis (## Analysis). Then, please provide your answer choice in a section named "
    "Answer (## Answer)."
)

SIMPLE_MEDRAG_SYSTEM = (
    "You are a helpful medical expert, and your task is to answer a medical question "
    "using the relevant documents."
)

SIMPLE_MEDRAG_PROMPT = "Here are the relevant documents:\n{context}\nHere is the question:\n{question}"

QUERY_PARSE_PROMPT = (
    "Parse the following passage and extract the queries as a list: {passage}.\n\n"
    "Present the queries as they are. DO NOT merge or break down queries. Output the list "
    'of queries in JSON format: {{"output": ["query 1", ..., "query N"]}}'
)


def format_question(question: str, options: dict[str, str]) -> str:
    option_text = "\n".join(f"{key}. {options[key]}" for key in sorted(options))
    return f"Here is the question:\n{question}\n\n{option_text}"


def format_query_planning(question_prompt: str, history: str, n_queries: int) -> str:
    prefix = f"{history}\n\n" if history else ""
    return f"{prefix}{question_prompt}\n\n{FOLLOW_UP_INSTRUCTION_ASK.format(n_queries)}"


def format_follow_up_answer(context: str, query: str) -> str:
    return SIMPLE_MEDRAG_PROMPT.format(context=context, question=query)


def format_final_follow_up(question_prompt: str, history: str) -> str:
    return f"{history}\n\n{question_prompt}\n\n{FOLLOW_UP_INSTRUCTION_ANSWER}"
