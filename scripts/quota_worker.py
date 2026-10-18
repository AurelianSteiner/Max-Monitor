#!/usr/bin/env python3
"""Read-only run/stream exporter using the worker's existing RS Hub SSH access.

Only sanitized IDs, customer/title, times, token counts and quota counters leave
the Mac. Cursor advancement follows the Hub's committed acknowledgement.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import sys
import time

LABEL = "de.rs.max-monitor.quota"
MAX_LINE = 8 * 1024 * 1024
MAX_EVENTS = 400
TOKEN_KEYS = {"input_tokens": "input_tokens", "output_tokens": "output_tokens",
              "cache_creation_input_tokens": "cache_create", "cache_read_input_tokens": "cache_read"}


def timestamp(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def text(value, length=300):
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))[:length]


def workflow(task_id, path=""):
    value = (task_id + " " + str(path)).lower()
    if "sales-" in value or value.startswith("sales:"):
        return "sales"
    if "korrektur" in value or "correction" in value:
        return "correction"
    if "translation" in value or "uebersetzung" in value or "übersetzung" in value:
        return "translation"
    if "klaviyo" in value or "upload" in value:
        return "upload"
    return "newsletter"


def configuration():
    with (Path.home() / "Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist").open("rb") as stream:
        service = plistlib.load(stream)
    args = service["ProgramArguments"]
    root = Path(service["WorkingDirectory"])
    node = next(a for a in args if Path(a).name == "node")
    cf = args[args.index("--config") + 1]
    # Existing config loader resolves defaults and relative paths. Never export
    # the whole configuration or any provider/Slack/ClickUp credentials.
    program = """const {loadConfig}=require(process.argv[1]+'/src/config.js');
const c=loadConfig(process.argv[2],{root:process.argv[1]});
console.log(JSON.stringify({worker:c.worker_id,paths:c.paths,hub:{ssh_host:c.hub.ssh_host,
identity_file:c.hub.identity_file,known_hosts_file:c.hub.known_hosts_file}}));"""
    result = subprocess.run([node, "-e", program, str(root), cf], capture_output=True, text=True, timeout=15, check=True)
    return json.loads(result.stdout)


def run_inventory(config, hours, now):
    filename = Path(config["paths"]["state_db"]).resolve()
    db = sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    columns = {r[1] for r in db.execute("PRAGMA table_info(runs)")}
    customer = "customer_name" if "customer_name" in columns else "NULL AS customer_name"
    cutoff = datetime.fromtimestamp(now - hours * 3600, timezone.utc).isoformat().replace("+00:00", "Z")
    result = []
    for row in db.execute("SELECT run_id,task_id,task_name,run_dir,state,started_at,finished_at," + customer +
                          " FROM runs WHERE finished_at IS NULL OR finished_at>=? ORDER BY queued_at DESC", (cutoff,)):
        row = dict(row)
        result.append({"run_id": text(row["run_id"], 240), "task_id": text(row["task_id"]),
                       "title": text(row["task_name"]), "customer": text(row["customer_name"]),
                       "kind": workflow(row["task_id"], row["run_dir"]), "started": row["started_at"],
                       "finished": row["finished_at"], "state": row["state"],
                       "stream": str(Path(row["run_dir"]) / "stream.jsonl")})
    db.close()
    known = {r["stream"] for r in result}
    runs_dir = Path(config["paths"]["runs_dir"])
    for stream in runs_dir.glob("*/stream.jsonl"):
        if str(stream) in known or stream.stat().st_mtime < now - hours * 3600:
            continue
        # Sales and other non-DB Claude jobs are still recorded. Their unknown
        # customer/state is explicit rather than guessed from a similar name.
        directory = stream.parent
        sales = re.match(r"sales-([0-9]+\.[0-9]+)-", directory.name)
        result.append({"run_id": directory.name, "task_id": "sales:" + sales[1] if sales else directory.name,
                       "title": directory.name, "customer": "", "kind": "sales" if sales else "other",
                       "started": None, "finished": None, "state": "unverified",
                       "stream": str(stream)})
    return result


def read_chunk(filename, offset=0, last_at=None, limit=MAX_EVENTS):
    """Consume complete lines only; timestamps adjacent to quota events are marked.

    Provider rate_limit_event records have no own timestamp. The most recent
    timestamp in the same stream is retained as an explicitly approximate time.
    """
    output = []
    messages = {}
    skipped = 0
    with open(filename, "rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        if offset > size:
            offset, last_at = 0, None
        stream.seek(offset)
        while len(output) + len(messages) < limit:
            begin = stream.tell()
            line = stream.readline(MAX_LINE + 1)
            if not line:
                break
            if not line.endswith(b"\n"):
                if len(line) <= MAX_LINE:
                    stream.seek(begin)
                    break
                while line and not line.endswith(b"\n"):
                    line = stream.readline(MAX_LINE + 1)
                skipped += 1
                continue
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                skipped += 1
                continue
            at = timestamp(event.get("timestamp"))
            if at is not None:
                last_at = at
            event_type = event.get("type")
            if event_type == "assistant" and isinstance(event.get("message"), dict):
                message = event["message"]
                usage = message.get("usage") or {}
                message_id = message.get("id") or event.get("uuid")
                if not message_id or at is None or not isinstance(usage, dict):
                    continue
                key = "message:" + text(message_id, 200)
                item = messages.setdefault(key, {"id": key, "event_type": "message", "at": at,
                           "time_quality": "timestamp", "model": text(message.get("model"), 100)})
                for source, target in TOKEN_KEYS.items():
                    value = usage.get(source, 0)
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 10**10:
                        item[target] = max(item.get(target, 0), int(value))
            elif event_type == "rate_limit_event" and isinstance(event.get("rate_limit_info"), dict):
                info = event["rate_limit_info"]
                windows = {}
                for name, raw in (info.get("unifiedWindows") or {}).items():
                    if name not in ("five_hour", "seven_day") or not isinstance(raw, dict):
                        continue
                    value = raw.get("utilization")
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1:
                        windows[name] = {"percent": round(value * 100, 6), "reset": raw.get("resetsAt")}
                if windows:
                    event_id = event.get("uuid") or hashlib.sha256(line).hexdigest()
                    output.append({"id": "quota:" + text(event_id, 200), "event_type": "quota", "at": at or last_at,
                                   "time_quality": "timestamp" if at is not None else "adjacent" if last_at is not None else "unknown",
                                   "windows": windows})
        offset = stream.tell()
    return output + list(messages.values()), offset, last_at, skipped


def send(config, payload):
    hub = config["hub"]
    host = hub["ssh_host"]
    if not re.fullmatch(r"[A-Za-z0-9_.@:-]+", host):
        raise ValueError("Invalid existing Hub host")
    args = ["/usr/bin/ssh", "-i", os.path.expanduser(hub["identity_file"]), "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
            "-o", "UserKnownHostsFile=" + os.path.expanduser(hub["known_hosts_file"]),
            host, "python3 /opt/max-monitor-quota/quota_ledger.py ingest"]
    result = subprocess.run(args, input=json.dumps(payload), text=True, capture_output=True, timeout=45, check=True)
    answer = json.loads(result.stdout)
    if answer.get("ok") is not True:
        raise ValueError("No committed quota acknowledgement")
    return answer


def collect(config, cache, hours=72, sender=send, now=None):
    now = time.time() if now is None else now
    cache = Path(cache)
    cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cursors = sqlite3.connect(str(cache), timeout=5)
    cursors.execute("CREATE TABLE IF NOT EXISTS cursors(file TEXT PRIMARY KEY,offset INTEGER,at REAL,modified REAL)")
    inventory = run_inventory(config, hours, now)
    errors = 0
    sent = 0
    # First announce every job, including jobs without Claude usage. This never
    # means zero quota consumption: evidence completeness is a separate field.
    for start in range(0, len(inventory), 200):
        runs = [{k: v for k, v in r.items() if k != "stream"} for r in inventory[start:start + 200]]
        sender(config, {"schema": 1, "worker": config["worker"], "runs": runs, "events": [], "backfill_hours": hours})
    for run in inventory:
        filename = run["stream"]
        try:
            stat = Path(filename).stat()
        except OSError:
            continue
        saved = cursors.execute("SELECT offset,at,modified FROM cursors WHERE file=?", (filename,)).fetchone()
        if saved and saved[0] == stat.st_size and saved[2] == stat.st_mtime:
            continue
        offset, last_at = (saved[0], saved[1]) if saved else (0, None)
        # Bounded batches also allow launchd to recover a failed upload without
        # ever skipping data. Each event is independently idempotent at the Hub.
        for _ in range(20):
            events, after, last_at, skipped = read_chunk(filename, offset, last_at)
            errors += skipped
            for event in events:
                event["run_id"] = run["run_id"]
            announced = {k: v for k, v in run.items() if k != "stream"}
            announced.update(evidence_errors=skipped, pending_scan=int(after < stat.st_size))
            sender(config, {"schema": 1, "worker": config["worker"], "runs": [announced],
                            "events": events, "backfill_hours": hours, "errors": errors})
            cursors.execute("INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)", (filename, after, last_at, stat.st_mtime))
            cursors.commit()
            sent += len(events)
            if after == offset or after >= stat.st_size:
                break
            offset = after
    if not inventory:
        sender(config, {"schema": 1, "worker": config["worker"], "runs": [], "events": [], "backfill_hours": hours})
    cursors.close()
    return {"ok": True, "worker": config["worker"], "runs": len(inventory), "events_sent": sent, "skipped_lines": errors}


def install():
    home = Path.home()
    runtime = home / ".local/share/max-monitor-quota"
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = runtime / "quota_worker.py"
    current = Path(__file__).resolve()
    if current != source:
        source.write_bytes(current.read_bytes())
    os.chmod(source, 0o600)
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    agent.parent.mkdir(parents=True, exist_ok=True)
    value = {"Label": LABEL, "ProgramArguments": [sys.executable, str(source), "--once"],
             "StartInterval": 60, "RunAtLoad": True, "ProcessType": "Background", "LowPriorityIO": True,
             "StandardOutPath": str(runtime / "collector.log"), "StandardErrorPath": str(runtime / "collector-error.log")}
    # Only replace our observer; never unload/restart the newsletter service.
    subprocess.run(["/bin/launchctl", "bootout", "gui/" + str(os.getuid()), str(agent)], capture_output=True)
    with agent.open("wb") as stream:
        plistlib.dump(value, stream)
    os.chmod(agent, 0o600)
    subprocess.run(["/bin/launchctl", "bootstrap", "gui/" + str(os.getuid()), str(agent)], check=True, capture_output=True)
    return {"ok": True, "label": LABEL, "interval_seconds": 60, "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--cache", default=str(Path.home() / ".local/share/max-monitor-quota/cursors.sqlite"))
    args = parser.parse_args()
    if args.install:
        result = install()
    else:
        result = collect(configuration(), args.cache, args.hours)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        print(json.dumps({"ok": False, "error": "quota_export_failed", "at": datetime.now(timezone.utc).isoformat()}), file=sys.stderr)
        sys.exit(1)
