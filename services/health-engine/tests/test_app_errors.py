from __future__ import annotations

import unittest

from huiyi_health_engine.app import _http_error
from huiyi_health_engine.memory.ama_backend import AmaBackendError


class AppErrorTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
