#!/usr/bin/env python3
"""Recover only the passive quota collector when its real output stops advancing."""
import argparse
from datetime import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import subprocess
import time

SERVICE = "max-monitor-quota.service"
STALE_AFTER = 180
COOLDOWN = 600


def assess(summary, previous, service, now, monotonic):
    state = {"schema": 1, "checked_at": now, "pid": service.get("MainPID"),
             "last_restart": previous.get("last_restart", 0), "failures": 0}
    if service.get("ActiveState") != "active":
        return {**state, "status": "inactive", "restart": False}
    started = int(service.get("ActiveEnterTimestampMonotonic") or 0) / 1e6
    if monotonic - started < STALE_AFTER:
        return {**state, "status": "starting", "restart": False}
    try:
        at = datetime.fromisoformat(summary["generated_at"].replace("Z", "+00:00"))
        if at.tzinfo is None or summary.get("schema") != 2 or not isinstance(summary.get("by_kind"), list):
            raise ValueError("Invalid summary")
        age = now - at.timestamp()
        fresh = math.isfinite(age) and -60 <= age <= STALE_AFTER
    except (KeyError, ValueError, TypeError, OverflowError):
        age, fresh = None, False
    state["age_seconds"] = age
    if fresh:
        return {**state, "status": "healthy", "restart": False}
    same = previous.get("pid") == state["pid"] and previous.get("status") == "stale"
    failures = previous.get("failures", 0) if same else 0
    # Concurrent/manual repeated checks must not count as separate observations.
    if not same or now - previous.get("checked_at", 0) >= 20:
        failures += 1
    restart = failures >= 2 and now - state["last_restart"] >= COOLDOWN
    return {**state, "status": "stale", "failures": failures, "restart": restart}


def read_json(file):
    try:
        data = json.loads(file.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(file, state):
    temporary = file.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(state, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(file)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", default="/var/lib/max-monitor-quota/public/RSMACS01.json")
    parser.add_argument("--state", default="/var/lib/max-monitor-quota-watchdog/state.json")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    file = Path(args.state)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (file.parent / "check.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        output = subprocess.check_output(["systemctl", "show", SERVICE, "-p", "ActiveState",
                                          "-p", "MainPID", "-p", "ActiveEnterTimestampMonotonic"], text=True, timeout=10)
        service = dict(row.split("=", 1) for row in output.splitlines() if "=" in row)
        previous = read_json(file)
        state = assess(read_json(Path(args.summary)), previous, service, time.time(), time.monotonic())
        if state["restart"] and not args.check_only:
            # Persist the cooldown BEFORE acting, including failed attempts.
            state["last_restart"] = time.time()
            write_state(file, state)
            try:
                subprocess.run(["systemctl", "restart", SERVICE], check=True, timeout=45, capture_output=True)
                state["status"] = "restarted"
            except (subprocess.SubprocessError, OSError):
                state["status"] = "restart_failed"
                write_state(file, state)
                raise
        write_state(file, state)
        if args.check_only or state["status"] != previous.get("status") or state["restart"]:
            print(json.dumps(state))


if __name__ == "__main__":
    main()
