#!/usr/bin/env python3
"""Sample GPU and cgroup utilization without recording process arguments or prompts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time
from pathlib import Path


QUERY = (
    "timestamp,index,name,memory.total,memory.used,utilization.gpu,utilization.memory,"
    "temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,pstate,pci.bus_id"
)


def read_text(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--duration", type=float, default=0, help="0 runs until interrupted")
    args = parser.parse_args()
    if args.interval <= 0 or args.duration < 0:
        parser.error("interval must be positive and duration non-negative")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.touch(mode=0o600, exist_ok=False)
    args.output.chmod(0o600)
    started = time.monotonic()
    count = 0
    try:
        with args.output.open("a") as sink:
            while not args.duration or time.monotonic() - started < args.duration:
                try:
                    result = subprocess.run(
                        ["nvidia-smi", f"--query-gpu={QUERY}", "--format=csv,noheader,nounits"],
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    for line in result.stdout.splitlines():
                        fields = [field.strip() for field in line.split(",")]
                        if len(fields) != 14:
                            continue
                        row = {
                            "timestamp": fields[0],
                            "gpuIndex": fields[1],
                            "gpuName": fields[2],
                            "memoryTotalMiB": fields[3],
                            "memoryUsedMiB": fields[4],
                            "gpuUtilizationPercent": fields[5],
                            "memoryUtilizationPercent": fields[6],
                            "temperatureC": fields[7],
                            "powerW": fields[8],
                            "powerLimitW": fields[9],
                            "smClockMHz": fields[10],
                            "memoryClockMHz": fields[11],
                            "performanceState": fields[12],
                            "pciBusId": fields[13],
                            "sampledAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
                            "cgroupMemoryBytes": read_text(Path("/sys/fs/cgroup/memory.current")),
                            "cgroupCpuStat": read_text(Path("/sys/fs/cgroup/cpu.stat")),
                            "cgroupMemoryEvents": read_text(Path("/sys/fs/cgroup/memory.events")),
                        }
                        sink.write(json.dumps(row, separators=(",", ":")) + "\n")
                        count += 1
                    sink.flush()
                except Exception as error:  # class only; no command output or request data
                    sink.write(json.dumps({"sampledAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(), "errorClass": type(error).__name__}) + "\n")
                    sink.flush()
                time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    print(json.dumps({"samples": count, "output": str(args.output)}))


if __name__ == "__main__":
    main()
