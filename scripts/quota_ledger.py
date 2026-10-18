#!/usr/bin/env python3
"""Persistent, passive Claude quota ledger. Percentages are percentage points.

Account deltas are observations; their allocation to jobs is always an estimate.
No Claude calls, admission decisions, credentials or production task writes.
"""
import argparse
from bisect import bisect_right
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
import zlib
from urllib.parse import urlsplit
from quota_routing import routing_inputs

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
        CREATE TABLE IF NOT EXISTS account_resets(account TEXT,reset REAL,seen REAL,PRIMARY KEY(account,reset));
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
        CREATE TABLE IF NOT EXISTS worker_settings(worker TEXT PRIMARY KEY,at REAL,settings TEXT);
        CREATE TABLE IF NOT EXISTS compact_jobs(job TEXT PRIMARY KEY,finished REAL,payload BLOB);
        """)
        self.meta("schema", SCHEMA)
        self.db.commit()

    def meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (key, json.dumps(value)))

    def setting(self, key, default=None):
        row = self.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def reset(self, since):
        """Reset this ledger only. Never touch worker runs, source logs or Fleet."""
        since = stamp(since)
        if since is None or since > time.time() + 60:
            raise ValueError("Invalid tracking start")
        with self.db:
            for table in ("samples", "events", "runs", "compact_jobs", "collectors", "worker_settings", "bindings", "account_resets", "accounts", "metadata"):
                self.db.execute("DELETE FROM " + table)
            self.meta("schema", SCHEMA)
            self.meta("tracking_since", since)
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.execute("VACUUM")
        return {"ok": True, "tracking_since": iso(since)}

    def sample(self, key, account, worker, window, reset, at, percent, quality, source):
        if not number(percent) or not 0 <= percent <= 100 or at is None:
            return
        if at < self.setting("tracking_since", 0):
            return
        if reset is not None and (reset <= at or reset - at > 8 * 86400):
            return  # Old or impossible cycle, never a fresh post-reset baseline.
        self.db.execute("INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?,?,?,?)",
                        (key, account, worker, window, reset, at, percent, quality, source))

    def fleet(self, data, now=None):
        now = time.time() if now is None else now
        activity = {r.get("workerId"): r.get("activity") or {} for r in data.get("workerReports", [])}
        # Same exact device link as the Fleet read model; never match Mac names.
        # This identifies quota evidence only, never grants worker admission.
        explicit = {m.get('workerId') for m in data.get('machines', []) if m.get('workerId')}
        links = defaultdict(set)
        for link in data.get('workerLinks', []):
            if link.get('workerId') not in explicit:
                links[link.get('deviceId')].add(link.get('workerId'))
        for machine in data.get("machines", []):
            linked = links.get(machine.get('deviceId'), set())
            worker = clean(machine.get("workerId") or (next(iter(linked)) if len(linked) == 1 else None), 100)
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
                reset = stamp(limit.get("resetsAt"))
                # Identity evidence may outlive a usage value. A stale native
                # report can bind a NEW CLI observation, never claim fresh usage.
                if limit['kind'] == 'weekly' and reset is not None and at is not None and now - 14 * 86400 <= at <= now + 60 and abs(reset - now) <= 8 * 86400:
                    self.db.execute('INSERT INTO account_resets VALUES(?,?,?) ON CONFLICT(account,reset) DO UPDATE SET seen=MAX(seen,excluded.seen)', (account, reset, at))
                if (at is None or at > now + 60 or now - at > 900 or limit.get("usageError")
                        or bound.get("usageError") or machine.get("usageError")):
                    continue
                window = WINDOWS[limit["kind"]]
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
        since = self.setting("tracking_since", 0)
        with self.db:
            probe = payload.get('probe')
            if isinstance(probe, dict) and isinstance(probe.get('windows'), dict):
                at = stamp(probe.get('at'))
                weekly = probe['windows'].get('seven_day') or {}
                account = self.resolve(stamp(weekly.get('reset')))
                bound = self.db.execute('SELECT account FROM bindings WHERE worker=? AND until IS NULL', (worker,)).fetchone()
                if account and bound and bound[0] == account and at is not None and max(since, now - 900) <= at <= now + 60:
                    for window in ('five_hour', 'seven_day'):
                        value = probe['windows'].get(window) or {}
                        reset = stamp(value.get('reset'))
                        if reset is not None:
                            self.sample(identifier(['probe', worker, window, at, value]), account, worker, window,
                                        reset, at, value.get('percent'), 'reset_bound_probe', 'probe')
            settings = payload.get("settings")
            if isinstance(settings, dict):
                safe = {k: clean(v, 100) for k, v in settings.items()
                        if re.fullmatch(r"[a-z_]{1,40}", k) and isinstance(v, (str, int, float, bool))}
                self.db.execute("INSERT OR REPLACE INTO worker_settings VALUES(?,?,?)", (worker, now, json.dumps(safe)))
            for run in runs:
                run_id = clean(run.get("run_id"), 240)
                task_id = clean(run.get("task_id"), 300)
                kind = run.get("kind") if run.get("kind") in KINDS else "other"
                known = context.get("run:" + run_id) or (context.get("task:" + task_id) if kind == "sales" else None) or {}
                if not run_id or not task_id:
                    continue
                finished = stamp(known.get("finished") or run.get("finished"))
                if finished is not None and finished < since:
                    continue
                job = kind + ":" + task_id
                compact = self.db.execute("SELECT finished FROM compact_jobs WHERE job=?", (job,)).fetchone()
                if compact and finished is not None and finished <= compact[0] and now - compact[0] > 1800:
                    continue
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
                if since and (at is None or at < since):
                    continue
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
        policy_file = Path(os.environ.get("MAX_MONITOR_EFFORT_POLICY", "/var/lib/max-monitor/RSMACS01/effort-policy.json"))
        try:
            policy = json.loads(policy_file.read_text())
        except (OSError, ValueError):
            policy = {"schema": 1, "revision": 0, "phases": {}}
        return {"ok": True, "runs": len(runs), "events": len(events), "received_at": iso(now),
                "tracking_since": since, "effort_policy": policy}

    def resolve(self, weekly_reset):
        """Historical account identity is an explicitly inferred reset fingerprint.

        A unique matching current or preceding cycle is required. Never substitute
        the account currently logged into the worker after a handoff.
        """
        if weekly_reset is None:
            return None
        matches = set()
        for row in self.db.execute("SELECT DISTINCT account,reset FROM samples WHERE source IN ('fleet','probe') AND window='seven_day' AND reset IS NOT NULL UNION SELECT account,reset FROM account_resets"):
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
        cutoff = max(now - hours * 3600, self.setting("tracking_since", 0))
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
            quota_events[(event["worker"], event["job"])].append((event["at"], account))
        messages = defaultdict(list)
        unknown_messages = 0
        for e in self.db.execute("SELECT * FROM events WHERE event_type='message' AND at BETWEEN ? AND ?", (cutoff, now)):
            job = jobs.get(e["job"])
            if not job:
                continue
            job["sampled_messages"] += 1
            job["tokens"] += e["input_tokens"] + e["output_tokens"] + e["cache_create"] + e["cache_read"]
            nearby = [q for q in quota_events[(e["worker"], e["job"])] if q[0] is not None and abs(q[0] - e["at"]) <= 1800]
            nearest = min(nearby, key=lambda q: abs(q[0] - e["at"])) if nearby else None
            if not nearest or not nearest[1]:
                unknown_messages += 1
                continue
            # Equal share per observed assistant turn, explicitly estimated.
            # No undocumented token pricing is presented as subscription cost.
            messages[nearest[1]].append((e["at"], e["job"], 1, e["id"]))
        totals = defaultdict(lambda: {"observed_pp": 0.0, "estimated_assigned_pp": 0.0,
            "unattributed_pp": 0.0, "intervals": 0, "gaps": 0, "counter_decreases": 0})
        pairs = defaultdict(list)
        message_times = {}
        for account, entries in messages.items():
            entries.sort(key=lambda entry: entry[0])
            message_times[account] = [entry[0] for entry in entries]
        for row in self.db.execute("SELECT * FROM samples WHERE at BETWEEN ? AND ? AND reset IS NOT NULL ORDER BY at,source", (cutoff - 900, now)):
            pairs[(row["account"], row["window"], row["reset"])].append(row)
        covered = set()
        for (account, window, reset), rows in pairs.items():
            before = None
            charge_begin = None
            for row in rows:
                if before is None:
                    before = row
                    charge_begin = row['at']
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
                    charge_begin = row['at']
                    continue
                totals[key]["observed_pp"] += delta
                totals[key]["intervals"] += 1
                if delta == 0:
                    # Rounded plateaus censor small charges. Hold the turns until
                    # the next whole-point increase, instead of training zeroes.
                    before = row
                    continue
                weights = defaultdict(float)
                matched = []
                times = message_times.get(account, [])
                start = bisect_right(times, charge_begin)
                end = bisect_right(times, row["at"])
                for at, job, weight, event_id in messages[account][start:end]:
                    weights[job] += weight
                    matched.append((job, event_id))
                if weights:
                    denominator = sum(weights.values())
                    for job_id, weight in weights.items():
                        alloc = jobs[job_id]["allocations"].setdefault(account, {"five_hour_pp": None, "seven_day_pp": None})
                        alloc[window + "_pp"] = (alloc[window + "_pp"] or 0) + delta * weight / denominator
                    totals[key]["estimated_assigned_pp"] += delta
                    covered.update((job, event_id, window) for job, event_id in matched)
                else:
                    totals[key]["unattributed_pp"] += delta
                before = row
                charge_begin = row['at']
        per_window = defaultdict(lambda: defaultdict(int))
        for job, at, window in covered:
            per_window[job][window] += 1
            if window == 'seven_day':
                jobs[job]["attributed_messages"] += 1
        groups = {name: defaultdict(list) for name in ("kind", "customer", "account_kind", "customer_kind", "task")}
        for j in jobs.values():
            j["coverage"] = round(min(1, j["attributed_messages"] / max(1, j["sampled_messages"])), 4)
            j["coverage_by_window"] = {w: min(1, per_window[j['job']][w] / max(1, j['sampled_messages'])) for w in ('five_hour','seven_day')}
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
        return {"schema": SCHEMA, "accounts": [{"account": a, "tasks_per_week": None} for a in selected],
                "tasks_per_week": None, "reason": "quota_allocation_not_calibrated", "mix": mix}

    def dashboard(self, now=None):
        """Cumulative compressed task records and a bounded raw repair buffer."""
        now = time.time() if now is None else now
        since = self.setting("tracking_since", now)
        report = self.report(min(48, max(1, (now - since) / 3600 + 1)), now)
        archived = {r["job"]: json.loads(zlib.decompress(r["payload"])) for r in self.db.execute("SELECT * FROM compact_jobs")}
        jobs = dict(archived)
        terminal = {"fertig", "completed", "failed", "abgebrochen", "zeitlimit", "blockiert", "technisch_blockiert", "abgebrochen_neustart"}
        for j in report["jobs"]:
            if j["job"] in archived and stamp(j["started"]) is not None and stamp(j["started"]) < now - 48 * 3600:
                continue  # Never replace a full archived result with a partial window.
            closed = bool(j["finished"]) and not j["in_progress"] and bool(terminal.intersection(j["states"]))
            carryover = not j["started"] or stamp(j["started"]) < since
            if carryover and not j['sampled_messages']:
                continue  # Historical unfinished metadata is not new tracking.
            checked = closed and not carryover and not j['partial_window'] and not j["pending_scan"] and not j["evidence_errors"]
            session_ready = checked and j['coverage_by_window']['five_hour'] >= .8
            weekly_ready = checked and j['coverage_by_window']['seven_day'] >= .8
            ready = session_ready and weekly_ready
            entry = {k: j[k] for k in ("job", "kind", "customer", "title", "started", "finished", "workers", "states", "attempts")}
            entry.update(closed=closed, carryover=carryover, coverage=j["coverage"],
                         five_hour_pp=j["estimated_five_hour_pp"] if session_ready else None,
                         weekly_pp=j["estimated_weekly_pp"] if weekly_ready else None,
                         accounts=sorted(j["allocations"]), estimated=True,
                         check="carryover" if carryover else "complete" if ready else "pending_evidence" if closed else "running")
            # A new continuation after retention is counted, but cannot masquerade
            # as a complete new measurement when old evidence is already compacted.
            old = archived.get(j["job"])
            if old and old.get("finished") and j["started"] and stamp(j["started"]) > stamp(old["finished"]):
                entry.update(five_hour_pp=None, weekly_pp=None, check="reopened_after_retention")
            jobs[j["job"]] = entry
            if closed:
                encoded = zlib.compress(json.dumps(entry, separators=(",", ":"), ensure_ascii=False).encode(), 9)
                self.db.execute("INSERT OR REPLACE INTO compact_jobs VALUES(?,?,?)", (j["job"], stamp(j["finished"]), encoded))
        self.db.commit()

        def group(rows):
            result = []
            for key, selected in sorted(rows.items()):
                closed = [j for j in selected if j["closed"] and not j["carryover"]]
                values = {}
                for field in ("five_hour_pp", "weekly_pp"):
                    measured = [j[field] for j in closed if j[field] is not None]
                    values[field] = {"n": len(measured), "mean": statistics.mean(measured) if measured else None,
                                     "sd": statistics.pstdev(measured) if len(measured) > 1 else 0,
                                     "total": sum(measured)}
                result.append({"key": key, "tracked": len(selected), "closed": len(closed),
                               "carryover": sum(j["carryover"] for j in selected),
                               "pending": sum(j["check"] != "complete" and j["closed"] and not j["carryover"] for j in selected), **values})
            return result

        by_kind = {k: [] for k in sorted(KINDS)}
        by_account, by_customer = defaultdict(list), defaultdict(list)
        for j in jobs.values():
            by_kind[j["kind"]].append(j)
            by_customer[j["customer"] + "|" + j["kind"]].append(j)
            if len(j["accounts"]) == 1:
                by_account[j["accounts"][0] + "|" + j["kind"]].append(j)
        settings = [{"worker": r["worker"], "at": iso(r["at"]), "values": json.loads(r["settings"])}
                    for r in self.db.execute("SELECT * FROM worker_settings ORDER BY worker")]
        for setting in settings:
            account = next((a for a in report['accounts'] if a['worker'] == setting['worker']), None)
            if account:
                setting['values']['mac_name'] = account['name']
        # Final task records are compressed once; raw events are a bounded repair
        # buffer, not a forever-growing copy of Claude conversations.
        cutoff = now - 48 * 3600
        with self.db:
            old_jobs = [r[0] for r in self.db.execute("SELECT job FROM compact_jobs WHERE finished<?", (now - 1800,))
                        if jobs[r[0]]["closed"] and (jobs[r[0]]["check"] == "complete" or stamp(jobs[r[0]]["finished"]) < cutoff)]
            for job in old_jobs:
                self.db.execute("DELETE FROM events WHERE job=?", (job,))
                self.db.execute("DELETE FROM runs WHERE job=?", (job,))
            self.db.execute("DELETE FROM samples WHERE at<?", (cutoff - 1800,))
            self.db.execute('DELETE FROM account_resets WHERE seen<? AND reset<?', (now - 14 * 86400, now - WEEK))
        account_groups = group(by_account)
        return {"schema": 2, "generated_at": iso(now), "tracking_since": iso(since),
                "method": "observed_rounded_plateaus_equal_turn_share", "estimated": True,
                "raw_resolution_pp": 1, "forecast_enabled": False,
                "by_kind": group(by_kind), "by_account_kind": account_groups, "by_customer_kind": group(by_customer),
                "scheduling": self.scheduling(account_groups, now),
                "tracked": sum(not j['carryover'] for j in jobs.values()), "carryover": sum(j['carryover'] for j in jobs.values()),
                "closed": sum(j["closed"] and not j["carryover"] for j in jobs.values()),
                "recent_jobs": sorted(jobs.values(), key=lambda j: j["started"] or "", reverse=True)[:30],
                "account_deltas": report["account_deltas"], "settings": settings, "accounts": report['accounts'],
                "collectors": report["collectors"], "raw_retention_days": 2,
                "compact_bytes": self.db.execute("SELECT COALESCE(SUM(LENGTH(payload)),0) FROM compact_jobs").fetchone()[0]}

    def scheduling(self, groups, now):
        """Small read-only scheduling evidence, one shared budget per account.

        Keep timestamps on every window: a new summary never refreshes old quota.
        Resets must be confirmed by a newer sample, never extrapolated to zero.
        """
        workers = {}
        for binding in self.db.execute('SELECT worker,account FROM bindings WHERE until IS NULL'):
            worker, account = binding['worker'], binding['account']
            windows = {}
            for window in ('five_hour', 'seven_day'):
                row = self.db.execute("SELECT percent,reset,at FROM samples WHERE account=? AND window=? ORDER BY at DESC LIMIT 1",
                                      (account, window)).fetchone()
                if row:
                    windows[window] = {'used': row['percent'], 'reset': row['reset'], 'at': row['at']}
            costs = {g['key'][len(account)+1:]: {f: g[f] for f in ('five_hour_pp', 'weekly_pp')}
                     for g in groups if g['key'].startswith(account + '|')}
            workers[worker] = {'schema': 1, 'generated_at': iso(now), 'account': identifier(account)[:24],
                               'windows': windows, 'costs': costs}
        return {'schema': 1, 'generated_at': iso(now), 'workers': workers, 'routing': routing_inputs()}


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ingest", "collect", "serve", "report", "forecast", "status", "reset", "dashboard"))
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--fleet", default=DEFAULT_FLEET)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--output")
    parser.add_argument("--accounts", default="")
    parser.add_argument("--mix", default="newsletter=1")
    parser.add_argument("--since")
    parser.add_argument("--public", default="/var/lib/max-monitor-quota/public/RSMACS01.json")
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
                if args.output and time.time() - last_report >= 60:
                    write_json(args.public, ledger.dashboard())
                    os.chmod(Path(args.public).parent, 0o755)
                    os.chmod(args.public, 0o644)
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
    elif args.command == "dashboard":
        result = ledger.dashboard()
    elif args.command == "reset":
        result = ledger.reset(args.since)
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
