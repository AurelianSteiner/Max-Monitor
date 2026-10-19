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
from urllib.parse import urlsplit

LABEL = "de.rs.max-monitor.quota"
MAX_LINE = 8 * 1024 * 1024
MAX_EVENTS = 400
STAGE = "startup"
TOKEN_KEYS = {"input_tokens": "input_tokens", "output_tokens": "output_tokens",
              "cache_creation_input_tokens": "cache_create", "cache_read_input_tokens": "cache_read"}
from quota_usage import canonical, encode_packet, usage_metadata, VERSION as USAGE_VERSION


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
let policySupported=false,distributionSupported=false,runningRevision='';
try{
 const start=require(process.argv[1]+'/src/update-readiness').lastServiceStart(c.paths.log_file);
 const cp=require('node:child_process');
 const state=cp.execFileSync('/bin/launchctl',['print','gui/'+process.getuid()+'/de.ruegamer-steiner.ai-newsletter'],{encoding:'utf8',timeout:5000});
 const pid=Number(/^\s*pid = (\d+)\s*$/m.exec(state)?.[1]);
 if(start?.pid===pid && /^[a-f0-9]{40}$/.test(start?.head||'')){
  runningRevision=start.head;
  cp.execFileSync('git',['-C',process.argv[1],'cat-file','-e',start.head+':src/effort-policy.js'],{stdio:'pipe',timeout:5000});
  policySupported=true;
  try{cp.execFileSync('git',['-C',process.argv[1],'cat-file','-e',start.head+':src/quota-distribution.js'],{stdio:'pipe',timeout:5000});distributionSupported=true;}catch{}
 }
}catch{}
let quotaProbe=null;
try{
 const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(c.paths.state_db,{readOnly:true});
 const row=db.prepare("SELECT value FROM meta WHERE key='quota_windows'").get();db.close();
 if(row)quotaProbe=JSON.parse(row.value);
}catch{}
console.log(JSON.stringify({worker:c.worker_id,paths:c.paths,hub:{ssh_host:c.hub.ssh_host,
identity_file:c.hub.identity_file,known_hosts_file:c.hub.known_hosts_file},probe:quotaProbe,settings:{
newsletter:c.claude.effort,newsletter_review:c.claude.effort,
filing:require(process.argv[1]+'/src/kundenablage-step.js').kundenablageConfig(c).effort,
correction:require(process.argv[1]+'/src/korrektur-config.js').korrekturConfig(c).effort,
translation:c.translation.effort,upload:c.klaviyo.effort,slicing:c.slicen.effort,
sales:c.sales_newsletter?.effort||c.claude.effort,model:c.claude.model,
policy_supported:policySupported,distribution_supported:distributionSupported,running_revision:runningRevision
}}));"""
    result = subprocess.run([node, "-e", program, str(root), cf], capture_output=True, text=True, timeout=15, check=True)
    config = json.loads(result.stdout)
    # Sales uses its verified profile rather than the worker's general defaults.
    try:
        profile = json.loads((root / 'config/sales-profile.json').read_text())
        config['settings']['sales'] = profile['effort']
        skill = Path.home() / '.local/share/rs-sales-profile' / profile['id'] / 'releases' / profile['revision'] / 'skills/rs-sales-newsletter/assets/presentation/.claude/agents'
        for phase, agent in [('sales_build', 'nl-bau'), ('sales_review', 'nl-art-director'), ('sales_final', 'nl-abnahme')]:
            front = (skill / (agent + '.md')).read_text().split('---', 2)[1]
            value = re.search(r'^effort:\s*(low|medium|high|xhigh|max)\s*$', front, re.M)
            if value:
                config['settings'][phase] = value[1]
    except (OSError, ValueError, KeyError, IndexError):
        pass
    return config


def run_inventory(config, hours, now):
    filename = Path(config["paths"]["state_db"]).resolve()
    db = sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    columns = {r[1] for r in db.execute("PRAGMA table_info(runs)")}
    customer = "customer_name" if "customer_name" in columns else "NULL AS customer_name"
    earliest = max(now - hours * 3600, config.get('tracking_since', 0))
    cutoff = datetime.fromtimestamp(earliest, timezone.utc).isoformat().replace("+00:00", "Z")
    result = []
    session = "session_id" if "session_id" in columns else "NULL AS session_id"
    for row in db.execute("SELECT run_id,task_id,task_name,run_dir,state,started_at,finished_at," + session + "," + customer +
                          " FROM runs WHERE finished_at IS NULL OR finished_at>=? ORDER BY queued_at DESC", (cutoff,)):
        row = dict(row)
        result.append({"run_id": text(row["run_id"], 240), "task_id": text(row["task_id"]),
                       "title": text(row["task_name"]), "customer": text(row["customer_name"]),
                       "kind": workflow(row["task_id"], row["run_dir"]), "started": row["started_at"],
                       "finished": row["finished_at"], "state": row["state"],
                       "stream": str(Path(row["run_dir"]) / "stream.jsonl"), "session": row['session_id']})
    db.close()
    known = {r["stream"] for r in result}
    sales_active = {}
    for receipt in filename.parent.glob("sales-active*.json"):
        try:
            if receipt.stat().st_size > 65536:
                continue
            raw = json.loads(receipt.read_text())
            if raw.get("runDir"):
                sales_active[str(Path(raw["runDir"]))] = raw
        except (OSError, ValueError):
            continue
    runs_dir = Path(config["paths"]["runs_dir"])
    for stream in runs_dir.glob("*/stream.jsonl"):
        if str(stream) in known or stream.stat().st_mtime < earliest:
            continue
        # Sales and other non-DB Claude jobs are still recorded. Their unknown
        # customer/state is explicit rather than guessed from a similar name.
        directory = stream.parent
        sales = re.match(r"sales-([0-9]+\.[0-9]+)-", directory.name)
        active = sales_active.get(str(directory), {})
        customer = ""
        try:
            url = active.get("url")
            saved = directory / "ergebnis-sales.json"
            if not url and saved.is_file() and saved.stat().st_size <= 1024 * 1024:
                url = json.loads(saved.read_text()).get("shop_url")
            customer = text(urlsplit(url or "").hostname)
        except (OSError, ValueError):
            pass
        started = active.get("startedAt")
        started = datetime.fromtimestamp(started / 1000, timezone.utc).isoformat() if isinstance(started, (int, float)) else None
        result.append({"run_id": directory.name, "task_id": "sales:" + sales[1] if sales else directory.name,
                       "title": "Sales · " + customer if sales and customer else directory.name,
                       "customer": customer, "kind": "sales" if sales else "other",
                       "started": started, "finished": None, "state": "running" if active else "unverified",
                       "stream": str(stream), "session": active.get('sessionId')})
    # Slicing, filing, translations and reviews are part of the same customer
    # job. Include their streams without counting them as extra logical tasks.
    children = []
    for run in result:
        root = Path(run['stream']).parent
        streams = []
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in {'skill-release','node_modules','.git','dist','screens','assets'} and not Path(directory,d).is_symlink()]
            if len(Path(directory).relative_to(root).parts) >= 6:
                dirs[:] = []
            if 'stream.jsonl' in files and Path(directory) != root:
                streams.append(Path(directory,'stream.jsonl'))
        session_id = run.get('session')
        if isinstance(session_id,str) and re.fullmatch(r'[a-f0-9-]{36}',session_id):
            streams.extend((Path.home()/'.claude/projects').glob('*/'+session_id+'/subagents/agent-*.jsonl'))
        for stream in streams:
            if stream.is_symlink():
                continue
            child = dict(run)
            child['stream'] = str(stream)
            child['run_id'] = run['run_id'][:170] + ':part:' + hashlib.sha256(str(stream).encode()).hexdigest()[:20]
            children.append(child)
    result.extend(children)
    return result


def measurement(event, at):
    """Retain every distinct usage/tool measurement, never prompts or tool data."""
    message = event.get('message') or {}
    if not isinstance(message, dict):
        return None
    kind = event.get('type')
    content = message.get('content') or []
    blocks = content if isinstance(content, list) else []
    if kind == 'assistant':
        tools = [{'id': text(b.get('id'), 200), 'name': text(b.get('name'), 160),
                  'input_bytes': len(canonical(b.get('input')))}
                 for b in blocks if isinstance(b, dict) and b.get('type') == 'tool_use']
        return {'type': 'assistant', 'id': 'message:' + text(message.get('id') or event.get('uuid'), 200),
                'at': at, 'model': text(message.get('model'), 100),
                'usage': usage_metadata(message.get('usage') or {}), 'tools': tools}
    if kind == 'user':
        results = [{'id': text(b.get('tool_use_id'), 200), 'error': bool(b.get('is_error')),
                    'result_bytes': len(canonical(b.get('content')))}
                   for b in blocks if isinstance(b, dict) and b.get('type') == 'tool_result']
        return {'type': 'tool_results', 'at': at, 'results': results} if results else None
    return None


def read_chunk(filename, offset=0, last_at=None, limit=MAX_EVENTS, since=0):
    """Consume complete lines only; timestamps adjacent to quota events are marked.

    Provider rate_limit_event records have no own timestamp. The most recent
    timestamp in the same stream is retained as an explicitly approximate time.
    """
    output = []
    messages = {}
    observations = {}
    skipped = 0
    with open(filename, "rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        if offset > size:
            offset, last_at = 0, None
        stream.seek(offset)
        while len(output) + len(messages) < limit and len(observations) < limit:
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
            if since and (last_at or 0) < since:
                continue  # Backfill old file prefixes without empty network batches.
            event_type = event.get("type")
            observed = measurement(event, at or last_at)
            if event_type == 'result':
                observed = {'type': 'result', 'at': at or last_at,
                            'usage': usage_metadata(event.get('usage') or {}),
                            'model_usage': usage_metadata(event.get('modelUsage') or {}),
                            'metrics': usage_metadata({k: event[k] for k in
                                ('total_cost_usd', 'duration_ms', 'duration_api_ms', 'num_turns', 'is_error') if k in event})}
            if observed:
                observations[hashlib.sha256(canonical(observed)).hexdigest()] = observed
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
    if observations:
        # Evidence is sent as a compressed packet by collect, separately from
        # the small hot message index. Result aggregates never enter that index.
        output.append({'event_type': 'evidence', 'observations': list(observations.values())})
    return output + list(messages.values()), offset, last_at, skipped


def send(config, payload):
    hub = config["hub"]
    host = hub["ssh_host"]
    if not re.fullmatch(r"[A-Za-z0-9_.@:-]+", host):
        raise ValueError("Invalid existing Hub host")
    args = ["/usr/bin/ssh", "-i", os.path.expanduser(hub["identity_file"]), "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes", "-o", "Compression=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
            "-o", 'UserKnownHostsFile="' + os.path.expanduser(hub["known_hosts_file"]).replace('"', '\\"') + '"',
            host, "python3 /opt/max-monitor-quota/quota_ledger.py ingest"]
    result = subprocess.run(args, input=json.dumps(payload), text=True, capture_output=True, timeout=45, check=True)
    answer = json.loads(result.stdout)
    if answer.get("ok") is not True:
        raise ValueError("No committed quota acknowledgement")
    return answer


def collect(config, cache, hours=72, sender=send, now=None):
    global STAGE
    now = time.time() if now is None else now
    cache = Path(cache)
    cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cursors = sqlite3.connect(str(cache), timeout=5)
    cursors.execute("CREATE TABLE IF NOT EXISTS cursors(file TEXT PRIMARY KEY,offset INTEGER,at REAL,modified REAL)")
    cursors.execute("CREATE TABLE IF NOT EXISTS tracker_meta(key TEXT PRIMARY KEY,value TEXT)")
    settings = dict(config.get("settings") or {})
    settings['usage_version'] = USAGE_VERSION
    policy_path = cache.parent / "effort-policy.json"
    try:
        current_policy = json.loads(policy_path.read_text())
        settings["policy_revision"] = int(current_policy.get("revision", 0))
        for phase, value in current_policy.get("phases", {}).items():
            settings[phase] = value
    except (OSError, ValueError, TypeError):
        settings["policy_revision"] = 0
    answer = sender(config, {"schema": 1, "worker": config["worker"], "runs": [], "events": [],
                             "settings": settings, "probe": config.get('probe'), "backfill_hours": hours}) or {}
    since = answer.get("tracking_since") or 0
    config['tracking_since'] = since
    prior = cursors.execute("SELECT value FROM tracker_meta WHERE key='tracking_since'").fetchone()
    usage_version = cursors.execute("SELECT value FROM tracker_meta WHERE key='usage_version'").fetchone()
    if (since and (not prior or float(prior[0]) != since)) or not usage_version or usage_version[0] != USAGE_VERSION:
        cursors.execute('DELETE FROM cursors')
        cursors.execute("INSERT OR REPLACE INTO tracker_meta VALUES('tracking_since',?)", (str(since),))
        cursors.execute("INSERT OR REPLACE INTO tracker_meta VALUES('usage_version',?)", (USAGE_VERSION,))
        cursors.commit()
    policy = answer.get("effort_policy")
    if isinstance(policy, dict) and policy.get("schema") == 1 and isinstance(policy.get("phases"), dict):
        phases = {k: v for k, v in policy["phases"].items()
                  if k in {"newsletter", "newsletter_review", "correction", "translation", "upload", "slicing", "sales", "sales_build", "sales_review", "sales_final", "filing"}
                  and v in {"low", "medium", "high", "xhigh", "max"}}
        safe = {"schema": 1, "revision": int(policy.get("revision", 0)), "phases": phases}
        temporary = policy_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(safe, separators=(",", ":")))
        os.chmod(temporary, 0o600)
        temporary.replace(policy_path)
    STAGE = "inventory"
    inventory = [r for r in run_inventory(config, hours, now)
                 if not r.get("finished") or (timestamp(r["finished"]) or 0) >= since]
    errors = 0
    sent = 0
    # First announce every job, including jobs without Claude usage. This never
    # means zero quota consumption: evidence completeness is a separate field.
    for start in range(0, len(inventory), 200):
        runs = [{k: v for k, v in r.items() if k not in ("stream", "session")} for r in inventory[start:start + 200]]
        for run, original in zip(runs, inventory[start:start + 200]):
            saved = cursors.execute("SELECT offset,modified FROM cursors WHERE file=?", (original["stream"],)).fetchone()
            try:
                stat = Path(original["stream"]).stat()
                run["pending_scan"] = int(not saved or saved[0] != stat.st_size or saved[1] != stat.st_mtime)
            except OSError:
                run["pending_scan"] = 0  # Missing evidence stays unknown, never a zero-cost task.
        STAGE = "announce"
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
            STAGE = "stream"
            events, after, last_at, skipped = read_chunk(filename, offset, last_at, since=since)
            observations = [o for e in events if e.get('event_type') == 'evidence' for o in e['observations']
                            if not since or (o.get('at') or 0) >= since]
            events = [e for e in events if e.get('event_type') != 'evidence']
            events = [e for e in events if not since or (e.get("at") or 0) >= since]
            errors += skipped
            for event in events:
                event["run_id"] = run["run_id"]
            announced = {k: v for k, v in run.items() if k not in ("stream", "session")}
            announced.update(evidence_errors=skipped, pending_scan=int(after < stat.st_size))
            STAGE = "export"
            sender(config, {"schema": 1, "worker": config["worker"], "runs": [announced],
                            "events": events, "backfill_hours": hours, "errors": errors,
                            "usage_packet": encode_packet(config['worker'], run['run_id'], observations) if observations else None})
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
        dependency = current.with_name('quota_usage.py')
        target = runtime / dependency.name
        target.write_bytes(dependency.read_bytes())
        os.chmod(target, 0o600)
    os.chmod(source, 0o600)
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    agent.parent.mkdir(parents=True, exist_ok=True)
    with (home / "Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist").open("rb") as stream:
        production = plistlib.load(stream)
    node = next(a for a in production["ProgramArguments"] if Path(a).name == "node")
    # Use the already authorized worker runtime as the responsible process.
    # A separate Python launchd entry cannot read Documents on protected Macs.
    wrapper = "const r=require('node:child_process').spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)"
    value = {"Label": LABEL, "ProgramArguments": [node, "-e", wrapper, sys.executable, str(source), "--once"],
             "WorkingDirectory": str(runtime),
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
    global STAGE
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
        STAGE = "configuration"
        result = collect(configuration(), args.cache, args.hours)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        diagnostic = {"ok": False, "error": "quota_export_failed", "stage": STAGE,
                      "exception": type(error).__name__, "errno": getattr(error, "errno", None),
                      "exit_code": getattr(error, "returncode", None), "at": datetime.now(timezone.utc).isoformat()}
        stderr = str(getattr(error, "stderr", "") or "").lower()
        diagnostic["permission_denied"] = "permission denied" in stderr or "operation not permitted" in stderr
        print(json.dumps(diagnostic), file=sys.stderr)
        sys.exit(1)
