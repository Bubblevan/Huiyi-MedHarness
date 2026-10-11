from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from huiyi_health_engine.app import _http_error, evaluation_config
from huiyi_health_engine.memory.ama_backend import AmaBackendError
from huiyi_health_engine.runtime import HEALTH_ENGINE_SOURCE_SHA256


class AppErrorTests(unittest.TestCase):
    @staticmethod
    def request_from(host: str) -> Request:
        return Request({
            "type": "http", "method": "GET", "path": "/_internal/evaluation/config",
            "headers": [], "query_string": b"", "client": (host, 1234), "server": ("127.0.0.1", 8325),
        })

    def test_ama_failure_returns_class_only_without_upstream_message(self) -> None:
        error = _http_error(AmaBackendError("IndexError"))

        self.assertEqual(error.status_code, 503)
        self.assertEqual(
            error.detail,
            {"error": "backend", "errorClass": "IndexError"},
        )

    def test_invalid_error_class_is_replaced_with_safe_label(self) -> None:
        error = _http_error(AmaBackendError("IndexError: private content"))

        self.assertEqual(
            error.detail,
            {"error": "backend", "errorClass": "UpstreamError"},
        )

    def test_evaluation_route_attestation_is_opt_in_and_loopback_only(self) -> None:
        with patch.dict("os.environ", {"HUIYI_ENABLE_EVALUATION_CONFIG": "0"}, clear=False):
            with self.assertRaises(HTTPException) as disabled:
                evaluation_config(self.request_from("127.0.0.1"))
        self.assertEqual(disabled.exception.status_code, 404)

        with patch.dict("os.environ", {"HUIYI_ENABLE_EVALUATION_CONFIG": "1"}, clear=False):
            with self.assertRaises(HTTPException) as remote:
                evaluation_config(self.request_from("10.0.0.8"))
        self.assertEqual(remote.exception.status_code, 403)

        with patch.dict("os.environ", {
            "HUIYI_ENABLE_EVALUATION_CONFIG": "1",
            "HUIYI_LOCAL_LLM_MODEL": "gpt-6-luna",
            "HUIYI_LOCAL_LLM_BASE_URL": "http://127.0.0.1:8333/v1/chat/completions",
            "AMA_LLM_BASE_URL": "http://127.0.0.1:8333/v1/chat/completions",
            "HUIYI_RAG_PLANNER_MODEL": "gpt-6-luna",
            "HUIYI_RAG_PLANNER_BASE_URL": "http://127.0.0.1:8333/v1/chat/completions",
            "HUIYI_RAG_ENABLED": "1",
            "HUIYI_LOCAL_EMBEDDING_MODEL": "Qwen3-Embedding-0.6B",
            "HUIYI_MEMORY_ISOLATE_RECALLS": "1",
        }, clear=False):
            attestation = evaluation_config(self.request_from("127.0.0.1"))

        self.assertEqual(attestation["amaModel"], "gpt-6-luna")
        self.assertEqual(attestation["amaEndpoint"], "http://127.0.0.1:8333/v1/chat/completions")
        self.assertEqual(attestation["ragPlannerModel"], "gpt-6-luna")
        self.assertTrue(attestation["ragEnabled"])
        self.assertTrue(attestation["memoryRecallIsolation"])
        self.assertEqual(attestation["embeddingModel"], "Qwen3-Embedding-0.6B")
        self.assertEqual(attestation["healthEngineSourceSha256"], HEALTH_ENGINE_SOURCE_SHA256)
        self.assertRegex(attestation["healthEngineSourceSha256"], r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
