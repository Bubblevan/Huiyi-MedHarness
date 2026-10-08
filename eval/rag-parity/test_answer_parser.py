from answer_parser import parse_choice


def test_parse_bare_and_json_choices():
    assert parse_choice("C") == ("C", "bare_choice")
    assert parse_choice('{"answer_choice":"B"}') == ("B", "json_choice")


def test_parse_qwen_fenced_json_with_option_description():
    raw = 'Reasoning omitted.\n```json\n{"thought_process":"...","answer":"D. Example option"}\n```'
    assert parse_choice(raw) == ("D", "json_choice_with_option_text")


def test_parse_known_think_wrapper_and_reject_prose_guess():
    assert parse_choice('<think>reasoning</think>\n{"answer":"A"}') == ("A", "json_choice")
    assert parse_choice("The answer is D") == (None, "parse_failure")
