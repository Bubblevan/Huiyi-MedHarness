#!/usr/bin/env python3
"""Poll the local vLLM Prometheus endpoint and store numeric metadata only."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import time
from pathlib import Path
from urllib.request import urlopen


SAMPLE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$")
LABEL = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')


def parse_labels(raw: str) -> dict[str, str]:
    if not raw:
        return {}
    labels = {}
    for key, value in LABEL.findall(raw[1:-1]):
        labels[key] = bytes(value, "utf-8").decode("unicode_escape")
    return labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000/metrics")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be positive")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.touch(mode=0o600, exist_ok=False)
    args.output.chmod(0o600)
    count = 0
    try:
        with args.output.open("a") as sink:
            while True:
                sampled_at = dt.datetime.now(dt.timezone.utc).isoformat()
                try:
                    with urlopen(args.url, timeout=3) as response:
                        payload = response.read().decode("utf-8", errors="replace")
                    for line in payload.splitlines():
                        match = SAMPLE.match(line)
                        if not match:
                            continue
                        name, raw_labels, raw_value = match.groups()
                        try:
                            value = float(raw_value)
                        except ValueError:
                            continue
                        sink.write(json.dumps({
                            "timestampUtc": sampled_at,
                            "metric": name,
                            "labels": parse_labels(raw_labels or ""),
                            "value": value,
                        }, separators=(",", ":")) + "\n")
                        count += 1
                    sink.flush()
                except Exception as error:  # retain class only; never response bodies
                    sink.write(json.dumps({"timestampUtc": sampled_at, "scrapeErrorClass": type(error).__name__}) + "\n")
                    sink.flush()
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print(json.dumps({"samples": count, "output": str(args.output)}))


if __name__ == "__main__":
    main()
