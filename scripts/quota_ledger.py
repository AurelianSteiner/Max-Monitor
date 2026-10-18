#!/usr/bin/env python3
"""Persistent, passive Claude quota ledger. Percentages are percentage points.

Account deltas are observations; their allocation to jobs is always an estimate.
No Claude calls, admission decisions, credentials or production task writes.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import statistics
import sys
import time
from urllib.parse import urlsplit

SCHEMA = 1
WEEK = 7 * 86400
WINDOWS = {"session": "five_hour", "weekly": "seven_day"}
KINDS = {"newsletter", "correction", "translation", "upload", "sales", "other"}
DEFAULT_DB = "/var/lib/max-monitor-quota/ledger.sqlite"
DEFAULT_FLEET = "/var/lib/max-monitor/RSMACS01/fleet.json"


def stamp(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def iso(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat().replace("+00:00", "Z")


def clean(value, limit=300):
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))[:limit]


def identifier(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class Ledger:
    def __init__(self, filename):
        if str(filename) != ":memory:":
            Path(filename).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(filename), timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts(account TEXT PRIMARY KEY,worker TEXT,name TEXT,
          first_seen REAL,last_seen REAL,max_tasks INTEGER);
        CREATE TABLE IF NOT EXISTS bindings(worker TEXT,account TEXT,since REAL,until REAL,
          PRIMARY KEY(worker,since));
        CREATE TABLE IF NOT EXISTS samples(id TEXT PRIMARY KEY,account TEXT,worker TEXT,
          window TEXT,reset REAL,at REAL,percent REAL,quality TEXT,source TEXT);
        CREATE INDEX IF NOT EXISTS samples_account_time ON samples(account,window,at);
        CREATE TABLE IF NOT EXISTS runs(worker TEXT,run_id TEXT,job TEXT,task_id TEXT,title TEXT,
          customer TEXT,kind TEXT,started REAL,finished REAL,state TEXT,last_seen REAL,
          evidence_errors INTEGER DEFAULT 0,pending_scan INTEGER DEFAULT 1,
          PRIMARY KEY(worker,run_id));
        CREATE INDEX IF NOT EXISTS runs_job ON runs(job);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,event_type TEXT,job TEXT,
          worker TEXT,run_id TEXT,at REAL,time_quality TEXT,windows TEXT,model TEXT,
          input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,
          cache_create INTEGER DEFAULT 0,cache_read INTEGER DEFAULT 0);
        CREATE INDEX IF NOT EXISTS events_time ON events(at,event_type);
        CREATE INDEX IF NOT EXISTS events_run ON events(worker,run_id,event_type,at);
        CREATE TABLE IF NOT EXISTS collectors(worker TEXT PRIMARY KEY,last_seen REAL,
          scanned INTEGER,backfill_hours INTEGER,errors INTEGER);
        """)
        self.meta("schema", SCHEMA)
        self.db.commit()

    def meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (key, json.dumps(value)))

    def sample(self, key, account, worker, window, reset, at, percent, quality, source):
        if not number(percent) or not 0 <= percent <= 100 or at is None:
            return
        if reset is not None and (reset <= at or reset - at > 8 * 86400):
            return  # Old or impossible cycle, never a fresh post-reset baseline.
        self.db.execute("INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?,?,?,?)",
                        (key, account, worker, window, reset, at, percent, quality, source))

    def fleet(self, data, now=None):
        now = time.time() if now is None else now
        activity = {r.get("workerId"): r.get("activity") or {} for r in data.get("workerReports", [])}
        for machine in data.get("machines", []):
            worker = clean(machine.get("workerId"), 100)
            if not worker:
                continue
            accounts = machine.get("accounts") or []
            bound = next((a for a in accounts if a.get("accountId") == machine.get("monitoringAccountId")
                          and a.get("provider") == "claude"), None)
            if not bound:
                continue
            account = clean(bound.get("name"), 200).lower()
            if "@" not in account:
                account = "monitor:" + clean(bound.get("accountId"), 100)
            self.db.execute("""INSERT INTO accounts VALUES(?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET
              worker=excluded.worker,name=excluded.name,last_seen=excluded.last_seen,
              max_tasks=COALESCE(excluded.max_tasks,accounts.max_tasks)""",
                            (account, worker, clean(machine.get("name")), now, now,
                             (machine.get("activity") or activity.get(worker) or {}).get("maxTasks")))
            current = self.db.execute("SELECT account FROM bindings WHERE worker=? AND until IS NULL", (worker,)).fetchone()
            if not current or current[0] != account:
                self.db.execute("UPDATE bindings SET until=? WHERE worker=? AND until IS NULL", (now, worker))
                self.db.execute("INSERT INTO bindings VALUES(?,?,?,NULL)", (worker, account, now))
            for limit in machine.get("limits", []):
                if limit.get("accountId") != bound.get("accountId") or limit.get("kind") not in WINDOWS:
                    continue
                at = stamp(limit.get("usageUpdatedAt") or bound.get("usageUpdatedAt") or machine.get("usageUpdatedAt"))
                if (at is None or at > now + 60 or now - at > 900 or limit.get("usageError")
                        or bound.get("usageError") or machine.get("usageError")):
                    continue
                window = WINDOWS[limit["kind"]]
                reset = stamp(limit.get("resetsAt"))
                key = identifier([account, window, reset, at, limit.get("percent"), "fleet"])
                self.sample(key, account, worker, window, reset, at, limit.get("percent"), "monitor_bound", "fleet")
        context = {}
        for task in (data.get("queue") or {}).get("tasks", []):
            customer = clean(task.get("company"))
            if task.get("workflow") == "sales" and not customer:
                try:
                    customer = clean(urlsplit(task.get("url") or "").hostname)
                except ValueError:
                    pass
            facts = {"customer": customer, "title": clean(task.get("title")),
                     "finished": task.get("completedAt") if task.get("status") == "completed" else None,
                     "state": "completed" if task.get("status") == "completed" else None}
            if task.get("attemptId"):
                context["run:" + clean(task["attemptId"], 240)] = facts
            if task.get("workflow") == "sales" and task.get("id"):
                context["task:" + clean(task["id"])] = facts
        self.meta("task_context", context)
        self.meta("last_fleet_sample", iso(now))
        self.db.commit()

    def ingest(self, payload, now=None):
        now = time.time() if now is None else now
        worker = payload.get("worker")
        if payload.get("schema") != SCHEMA or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", str(worker or "")):
            raise ValueError("Invalid quota collector identity")
        runs, events = payload.get("runs", []), payload.get("events", [])
        if not isinstance(runs, list) or not isinstance(events, list) or len(runs) > 1000 or len(events) > 1000:
            raise ValueError("Quota batch exceeds limit")
        saved_context = self.db.execute("SELECT value FROM metadata WHERE key='task_context'").fetchone()
        context = json.loads(saved_context[0]) if saved_context else {}
        with self.db:
            for run in runs:
                run_id = clean(run.get("run_id"), 240)
                task_id = clean(run.get("task_id"), 300)
                kind = run.get("kind") if run.get("kind") in KINDS else "other"
                known = context.get("run:" + run_id) or (context.get("task:" + task_id) if kind == "sales" else None) or {}
                if not run_id or not task_id:
                    continue
                job = kind + ":" + task_id
                self.db.execute("""INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(worker,run_id)
                  DO UPDATE SET title=excluded.title,customer=COALESCE(NULLIF(excluded.customer,''),runs.customer),
                  started=COALESCE(runs.started,excluded.started),
                  finished=COALESCE(excluded.finished,runs.finished),
                  state=CASE WHEN excluded.state='unverified' THEN runs.state ELSE excluded.state END,last_seen=excluded.last_seen,
                  evidence_errors=MAX(runs.evidence_errors,excluded.evidence_errors),
                  pending_scan=COALESCE(excluded.pending_scan,runs.pending_scan)""",
                                (worker, run_id, job, task_id, clean(known.get("title") or run.get("title")),
                                 clean(run.get("customer") or known.get("customer")), kind,
                                 stamp(run.get("started")), stamp(known.get("finished") or run.get("finished")),
                                 clean(known.get("state") or run.get("state"), 80), now,
                                 max(0, int(run.get("evidence_errors", 0))), run.get("pending_scan")))
            for event in events:
                event_id = clean(event.get("id"), 240)
                kind = event.get("event_type")
                run_id = clean(event.get("run_id"), 240)
                run = self.db.execute("SELECT job FROM runs WHERE worker=? AND run_id=?", (worker, run_id)).fetchone()
                if not event_id or kind not in ("message", "quota") or not run:
                    continue
                at = stamp(event.get("at"))
                if at is not None and (at > now + 60 or at < now - 366 * 86400):
                    continue
                windows = {}
                for name, raw in (event.get("windows") or {}).items():
                    if name not in ("five_hour", "seven_day") or not isinstance(raw, dict):
                        continue
                    percent, reset = raw.get("percent"), stamp(raw.get("reset"))
                    if number(percent) and 0 <= percent <= 100:
                        windows[name] = {"percent": percent, "reset": reset}
                values = []
                for key in ("input_tokens", "output_tokens", "cache_create", "cache_read"):
                    val = event.get(key, 0)
                    values.append(int(val) if number(val) and 0 <= val <= 10**10 else 0)
                self.db.execute("""INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                  input_tokens=MAX(events.input_tokens,excluded.input_tokens),
                  output_tokens=MAX(events.output_tokens,excluded.output_tokens),
                  cache_create=MAX(events.cache_create,excluded.cache_create),
                  cache_read=MAX(events.cache_read,excluded.cache_read)""",
                                (event_id, kind, run[0], worker, run_id, at, clean(event.get("time_quality"), 40),
                                 json.dumps(windows), clean(event.get("model"), 100), *values))
            self.db.execute("INSERT OR REPLACE INTO collectors VALUES(?,?,?,?,?)",
                            (worker, now, len(events), int(payload.get("backfill_hours", 72)), int(payload.get("errors", 0))))
        return {"ok": True, "runs": len(runs), "events": len(events), "received_at": iso(now)}

    def resolve(self, weekly_reset):
        """Historical account identity is an explicitly inferred reset fingerprint.

        A unique matching current or preceding cycle is required. Never substitute
        the account currently logged into the worker after a handoff.
        """
        if weekly_reset is None:
            return None
        matches = set()
        for row in self.db.execute("SELECT DISTINCT account,reset FROM samples WHERE source='fleet' AND window='seven_day' AND reset IS NOT NULL"):
            if abs(weekly_reset - row["reset"]) < 1 or abs(weekly_reset - (row["reset"] - WEEK)) < 1:
                matches.add(row["account"])
        return next(iter(matches)) if len(matches) == 1 else None

    def materialize(self):
        # Re-resolve after a later fleet observation; raw evidence is never lost.
        resolved = {}
        for event in self.db.execute("SELECT * FROM events WHERE event_type='quota' AND at IS NOT NULL"):
            windows = json.loads(event["windows"])
            reset = (windows.get("seven_day") or {}).get("reset")
            if reset not in resolved:
                resolved[reset] = self.resolve(reset)
            account = resolved[reset]
            if not account:
                continue
            for window, value in windows.items():
                if event["time_quality"] not in ("timestamp", "adjacent"):
                    continue
                self.sample(identifier([event["id"], window]), account, event["worker"], window,
                            value["reset"], event["at"], value["percent"], "inferred_reset_cycle", "stream")
        self.db.commit()

    def report(self, hours=72, now=None):
        now = time.time() if now is None else now
        cutoff = now - hours * 3600
        self.materialize()
        jobs = {}
        for row in self.db.execute("SELECT * FROM runs WHERE COALESCE(finished,last_seen)>=?", (cutoff,)):
            j = jobs.setdefault(row["job"], {"job": row["job"], "task_id": row["task_id"], "title": row["title"],
                "customer": row["customer"] or "unknown", "kind": row["kind"], "attempts": 0,
                "states": set(), "workers": set(), "started": [], "finished": [], "allocations": {},
                "tokens": 0, "sampled_messages": 0, "attributed_messages": 0,
                "evidence_errors": 0, "pending_scan": False})
            j["attempts"] += 1
            j["states"].add(row["state"])
            j["workers"].add(row["worker"])
            j["evidence_errors"] += row["evidence_errors"] or 0
            j["pending_scan"] = j["pending_scan"] or bool(row["pending_scan"])
            if row["started"] is not None:
                j["started"].append(row["started"])
            if row["finished"] is not None:
                j["finished"].append(row["finished"])
        quota_events = defaultdict(list)
        resolved = {}
        for event in self.db.execute("SELECT * FROM events WHERE event_type='quota' AND at>=? ORDER BY at", (cutoff - 3600,)):
            windows = json.loads(event["windows"])
            reset = (windows.get("seven_day") or {}).get("reset")
            if reset not in resolved:
                resolved[reset] = self.resolve(reset)
            account = resolved[reset]
            quota_events[(event["worker"], event["run_id"])].append((event["at"], account))
        messages = defaultdict(list)
        unknown_messages = 0
        for e in self.db.execute("SELECT * FROM events WHERE event_type='message' AND at BETWEEN ? AND ?", (cutoff, now)):
            job = jobs.get(e["job"])
            if not job:
                continue
            job["sampled_messages"] += 1
            job["tokens"] += e["input_tokens"] + e["output_tokens"] + e["cache_create"] + e["cache_read"]
            nearby = [q for q in quota_events[(e["worker"], e["run_id"])] if q[0] is not None and abs(q[0] - e["at"]) <= 1800]
            nearest = min(nearby, key=lambda q: abs(q[0] - e["at"])) if nearby else None
            if not nearest or not nearest[1]:
                unknown_messages += 1
                continue
            # Work proxy, not a conversion from tokens to billed quota.
            weight = e["input_tokens"] + e["cache_create"] + .1 * e["cache_read"] + 5 * e["output_tokens"]
            messages[nearest[1]].append((e["at"], e["job"], max(1, weight), e["id"]))
        totals = defaultdict(lambda: {"observed_pp": 0.0, "estimated_assigned_pp": 0.0,
            "unattributed_pp": 0.0, "intervals": 0, "gaps": 0, "counter_decreases": 0})
        pairs = defaultdict(list)
        for row in self.db.execute("SELECT * FROM samples WHERE at BETWEEN ? AND ? AND reset IS NOT NULL ORDER BY at,source", (cutoff - 900, now)):
            pairs[(row["account"], row["window"], row["reset"])].append(row)
        covered = set()
        for (account, window, reset), rows in pairs.items():
            before = None
            for row in rows:
                if before is None:
                    before = row
                    continue
                if row["at"] <= before["at"]:
                    continue
                # Rounded fleet counters can be behind the CLI by one point.
                delta = row["percent"] - before["percent"]
                key = (account, window)
                if delta < 0:
                    totals[key]["counter_decreases"] += 1
                    # Keep the high-water mark: lagging or rounded counters may
                    # catch up later; counting that rebound would invent usage.
                    continue
                if row["at"] - before["at"] > 1800 or before["at"] < cutoff:
                    totals[key]["gaps"] += 1
                    before = row
                    continue
                totals[key]["observed_pp"] += delta
                totals[key]["intervals"] += 1
                weights = defaultdict(float)
                matched = []
                for at, job, weight, event_id in messages[account]:
                    if before["at"] < at <= row["at"]:
                        weights[job] += weight
                        matched.append((job, event_id))
                if weights:
                    denominator = sum(weights.values())
                    for job_id, weight in weights.items():
                        alloc = jobs[job_id]["allocations"].setdefault(account, {"five_hour_pp": None, "seven_day_pp": None})
                        alloc[window + "_pp"] = (alloc[window + "_pp"] or 0) + delta * weight / denominator
                    totals[key]["estimated_assigned_pp"] += delta
                    if window == "seven_day":
                        covered.update(matched)
                else:
                    totals[key]["unattributed_pp"] += delta
                before = row
        for job, at in covered:
            jobs[job]["attributed_messages"] += 1
        groups = {name: defaultdict(list) for name in ("kind", "customer", "account_kind", "customer_kind", "task")}
        for j in jobs.values():
            j["coverage"] = round(min(1, j["attributed_messages"] / max(1, j["sampled_messages"])), 4)
            j["completed"] = "fertig" in j["states"] or "completed" in j["states"]
            j["in_progress"] = "running" in j["states"] or "queued" in j["states"]
            for field, result in (("five_hour_pp", "estimated_five_hour_pp"), ("seven_day_pp", "estimated_weekly_pp")):
                values = [a[field] for a in j["allocations"].values() if a[field] is not None]
                j[result] = sum(values) if values else None
            j["duration_seconds"] = max(0, max(j["finished"]) - min(j["started"])) if j["finished"] and j["started"] and not j["in_progress"] else None
            # Averages train only on finished, sufficiently observed jobs. Missing
            # counters are unknown, never zero-cost completed tasks.
            j["partial_window"] = not j["started"] or min(j["started"]) < cutoff
            if (j["completed"] and not j["in_progress"] and not j["pending_scan"] and not j["evidence_errors"]
                    and not j["partial_window"]
                    and j["coverage"] >= .8 and j["estimated_weekly_pp"] is not None):
                groups["kind"][j["kind"]].append(j)
                groups["customer"][j["customer"]].append(j)
                groups["customer_kind"][j["customer"] + "|" + j["kind"]].append(j)
                groups["task"][j["task_id"].split("@")[0]].append(j)
                for account in j["allocations"]:
                    # Multi-account jobs stay in totals, not a falsely complete
                    # per-account job-cost baseline.
                    if len(j["allocations"]) == 1:
                        groups["account_kind"][account + "|" + j["kind"]].append(j)
            j["states"] = sorted(j["states"])
            j["workers"] = sorted(j["workers"])
            j["started"] = iso(min(j["started"])) if j["started"] else None
            j["finished"] = iso(max(j["finished"])) if j["finished"] else None
            j["measurement"] = "estimated_allocation" if j["allocations"] else "insufficient_quota_evidence"
        def describe(items):
            def metric(key):
                values = sorted(j[key] for j in items if j[key] is not None)
                return {"mean": statistics.mean(values), "median": statistics.median(values),
                        "p90": values[max(0, math.ceil(.9 * len(values)) - 1)]} if values else None
            return {"n": len(items), "weekly_pp": metric("estimated_weekly_pp"),
                    "five_hour_pp": metric("estimated_five_hour_pp"), "duration_seconds": metric("duration_seconds"),
                    "measurement": "estimated_allocation", "forecast_ready": len(items) >= 5}
        return {"schema": SCHEMA, "generated_at": iso(now), "hours": hours,
            "quality": {"job_allocations_are_estimates": True, "unknown_account_messages": unknown_messages,
                        "pending_scan_jobs": sum(bool(j["pending_scan"]) for j in jobs.values()),
                        "jobs_with_evidence_errors": sum(bool(j["evidence_errors"]) for j in jobs.values()),
                        "minimum_training_coverage": .8, "minimum_forecast_jobs": 5,
                        "five_hour_is_not_a_daily_limit": True,
                        "cross_account_percentages_not_capacity_equivalent": True,
                        "external_usage_can_overlap_jobs": True},
            "collectors": [dict(r) for r in self.db.execute("SELECT * FROM collectors ORDER BY worker")],
            "accounts": [dict(r) for r in self.db.execute("SELECT * FROM accounts ORDER BY account")],
            "account_deltas": [{"account": k[0], "window": k[1], **v} for k, v in sorted(totals.items())],
            "averages": {name: {key: describe(items) for key, items in sorted(group.items())} for name, group in groups.items()},
            "jobs": sorted(jobs.values(), key=lambda j: j["started"] or "", reverse=True)}

    def forecast(self, selected, mix, hours=168):
        report = self.report(max(72, hours))
        output = []
        for account in selected:
            if report["quality"]["pending_scan_jobs"]:
                output.append({"account": account, "tasks_per_week": None, "reason": "historical_backfill_in_progress"})
                continue
            values = []
            for kind, share in mix.items():
                row = report["averages"]["account_kind"].get(account + "|" + kind)
                if not row or not row["forecast_ready"] or not row["weekly_pp"] or row["weekly_pp"]["mean"] <= 0:
                    values = []
                    break
                values.append((share, row))
            if not values:
                output.append({"account": account, "tasks_per_week": None, "reason": "insufficient_completed_job_samples"})
                continue
            weekly = sum(share * row["weekly_pp"]["mean"] for share, row in values)
            session = sum(share * row["five_hour_pp"]["mean"] for share, row in values if row["five_hour_pp"])
            limit = min(100 / weekly, (168 / 5) * 100 / session) if session > 0 else 100 / weekly
            output.append({"account": account, "tasks_per_week": math.floor(limit), "estimated_weekly_pp_per_task": weekly,
                           "measurement": "estimated_upper_bound_before_slot_and_availability_limits"})
        return {"schema": SCHEMA, "accounts": output, "account_count": len(selected), "mix": mix,
                "tasks_per_week": sum(r["tasks_per_week"] for r in output) if output and all(r["tasks_per_week"] is not None for r in output) else None,
                "basis": "account_specific_completed_jobs; no equal-plan assumption; no paid overage"}


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ingest", "collect", "serve", "report", "forecast", "status"))
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--fleet", default=DEFAULT_FLEET)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--output")
    parser.add_argument("--accounts", default="")
    parser.add_argument("--mix", default="newsletter=1")
    args = parser.parse_args()
    ledger = Ledger(args.db)
    if args.command == "ingest":
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Quota batch too large")
        result = ledger.ingest(json.loads(raw))
    elif args.command in ("collect", "serve"):
        last_report = 0
        while True:
            try:
                ledger.fleet(json.loads(Path(args.fleet).read_text()))
                if args.output and time.time() - last_report >= 300:
                    for hours in (24, 72):
                        write_json(Path(args.output) / ("summary-%sh.json" % hours), ledger.report(hours))
                    last_report = time.time()
                result = {"ok": True, "sampled_at": iso()}
                if args.command == "collect":
                    break
            except (OSError, ValueError, sqlite3.Error):
                if args.command == "collect":
                    raise
                print(json.dumps({"ok": False, "at": iso(), "error": "quota_collection_failed"}), flush=True)
            time.sleep(max(5, args.interval))
    elif args.command == "report":
        result = ledger.report(args.hours)
    elif args.command == "forecast":
        pairs = [item.split("=", 1) for item in args.mix.split(",")]
        mix = {kind: float(share) for kind, share in pairs}
        if not mix or any(k not in KINDS or not math.isfinite(v) or v <= 0 for k, v in mix.items()):
            raise ValueError("Invalid workload mix")
        total = sum(mix.values())
        result = ledger.forecast([a.strip().lower() for a in args.accounts.split(",") if a.strip()], {k: v / total for k, v in mix.items()}, args.hours)
    else:
        result = {"schema": SCHEMA, "metadata": {r[0]: json.loads(r[1]) for r in ledger.db.execute("SELECT * FROM metadata")},
                  "counts": {table: ledger.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] for table in ("accounts", "runs", "events", "samples")},
                  "collectors": [dict(r) for r in ledger.db.execute("SELECT * FROM collectors")]}
    if args.output and args.command not in ("serve", "collect"):
        write_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
