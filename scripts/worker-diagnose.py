#!/usr/bin/env python3
"""Read-only worker diagnosis; never instantiates or migrates the worker store."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess

def object_file(file):
    try:
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def public_id(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9@_.:/-]{1,200}', value) else None


def receipt_fields(value):
    if not isinstance(value, dict):
        return {'readable': False}
    result = {'readable': True}
    for source, target in [('jobId', 'jobId'), ('owner', 'owner'), ('ts', 'threadId')]:
        identifier = public_id(value.get(source))
        if identifier:
            result[target] = identifier
    if isinstance(value.get('pid'), int) and not isinstance(value['pid'], bool) and value['pid'] > 0:
        result['pid'] = value['pid']
    if value.get('state') in ('queued', 'claiming', 'reserved', 'running', 'paused', 'building', 'delivery', 'done', 'blocked', 'aborted'):
        result['state'] = value['state']
    for key in ('at', 'startedAt', 'updatedAt', 'expiresAt'):
        timestamp = value.get(key)
        if isinstance(timestamp, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.+-]{8,25}Z?', timestamp):
            result[key] = timestamp
    return result


def process_start(pid):
    result = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True,
                            text=True, env={'LC_ALL': 'C', 'LANG': 'C', 'TZ': 'UTC0'})
    return (result.stdout.strip() or None) if result.returncode == 0 else None


def slot_evidence(config, start_of_process=process_start):
    """Explain the counter without changing leases or reopening paused work."""
    main = Path(config.get('macStateDb') or config['paths']['state_db'])
    files = [('main', main), ('sales-test', main.parent / 'sales-live-test/worker.sqlite')]
    entries, issues, seen_runs = [], [], set()
    for workspace, db_file in files:
        if db_file.is_file():
            try:
                db = sqlite3.connect(db_file.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
                try:
                    rows = db.execute("SELECT run_id,task_id,state,pid FROM runs WHERE state IN ('queued','running','paused') ORDER BY run_id")
                    for run_id, task_id, state, pid in rows:
                        counted = state != 'paused' and run_id not in seen_runs
                        reason = 'paused_run' if state == 'paused' else 'duplicate_run' if not counted else state + '_run'
                        if counted:
                            seen_runs.add(run_id)
                        entries.append({'workspace': workspace, 'kind': 'worker-run', 'runId': public_id(run_id),
                                        'taskId': public_id(task_id), 'state': state, 'pid': pid,
                                        'counted': counted, 'reason': reason})
                finally:
                    db.close()
            except sqlite3.Error:
                issues.append({'workspace': workspace, 'reason': 'database_unreadable'})
        directory = db_file.parent
        if not directory.is_dir():
            continue
        preview = directory / 'weekly-preview-active.json'
        if preview.exists():
            entries.append({'workspace': workspace, 'kind': 'preview', 'counted': True,
                            'reason': 'preview_lease', **receipt_fields(object_file(preview))})
        browser = directory / 'klaviyo-browser/owner.json'
        if browser.exists():
            value = object_file(browser)
            fields = receipt_fields(value)
            if config.get('browserEnabled') is True:
                counted, reason = True, 'browser_queue_enabled'
            else:
                pid = fields.get('pid')
                start = start_of_process(pid) if pid else None
                counted = bool(start and (not value.get('processStart') or start == value['processStart']))
                reason = 'browser_process_alive' if counted else 'inactive_browser_journal_retained'
            entries.append({'workspace': workspace, 'kind': 'browser', 'counted': counted, 'reason': reason, **fields})
        for file in sorted(directory.iterdir()):
            if not re.fullmatch(r'sales-active(?:-[1-9]\d*)?\.json', file.name):
                continue
            value = object_file(file)
            parked = value is not None and value.get('parked') is True
            entries.append({'workspace': workspace, 'kind': 'sales', 'counted': not parked,
                            'reason': 'parked_sales' if parked else 'sales_receipt', **receipt_fields(value)})
    occupied = sum(entry['counted'] for entry in entries)
    authoritative = config.get('authoritativeOccupiedTasks')
    return {'observedAt': datetime.now(timezone.utc).isoformat(), 'occupiedTasks': occupied,
            'authoritativeOccupiedTasks': authoritative,
            'consistent': occupied == authoritative if isinstance(authoritative, int) and not issues else None,
            'mayChangeDuringRead': True, 'entries': entries, 'issues': issues}


def read_state(db_file):
    db = sqlite3.connect(db_file.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        meta = {}
        for key in ['last_poll', 'worker_control', 'monitor_admission', 'claude_auslastung', 'claude_ausfall',
                    'last_update', 'rs_hub_mcp_update_failed', 'rs_hub_mcp_last_update']:
            row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
            try:
                meta[key] = json.loads(row[0]) if row else None
            except ValueError:
                meta[key] = {'invalid_json': True}
        if isinstance(meta.get('claude_auslastung'), dict):
            meta['claude_auslastung'].pop('token', None)
        active = [dict(zip(['runId', 'taskId', 'title', 'state', 'pid'], row)) for row in db.execute(
            "SELECT run_id,task_id,task_name,state,pid FROM runs WHERE state IN ('queued','running','paused') ORDER BY queued_at")]
        return meta, active
    finally:
        db.close()


def main():
    home = Path.home()
    plist = home / 'Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist'
    with plist.open('rb') as f:
        service = plistlib.load(f)
    args = service['ProgramArguments']
    node = next(a for a in args if Path(a).name == 'node')
    root = Path(service['WorkingDirectory'])
    config_file = Path(args[args.index('--config') + 1])
    script = """const{loadConfig}=require(process.argv[1]+'/src/config.js');
const c=loadConfig(process.argv[2],{root:process.argv[1]});
let occupied=null;try{occupied=require(process.argv[1]+'/src/mac-capacity.js').occupiedMacTasks(c);}catch{}
console.log(JSON.stringify({workerId:c.worker_id,paths:c.paths,macStateDb:c.mac_state_db,
browserEnabled:c.klaviyo_browser?.enabled===true,authoritativeOccupiedTasks:occupied}));"""
    config = json.loads(subprocess.check_output([node, '-e', script, str(root), str(config_file)], text=True))
    paths = config['paths']
    db_file = Path(paths['state_db']).resolve()
    meta, active = read_state(db_file)
    services = {}
    for label in ['de.ruegamer-steiner.ai-newsletter', 'de.rs.max-monitor.remote']:
        result = subprocess.run(['/bin/launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + label], capture_output=True, text=True)
        services[label] = {'loaded': result.returncode == 0, 'state': [line.strip() for line in result.stdout.splitlines()
            if line.strip().startswith(('state =', 'pid ='))]}
    git = {}
    for label, command in [('revision', ['rev-parse', 'HEAD']), ('changes', ['status', '--short'])]:
        result = subprocess.run(['/usr/bin/git', '-C', str(root), *command], capture_output=True, text=True)
        git[label] = result.stdout.strip() if result.returncode == 0 else None
    print(json.dumps({'workerId': config['workerId'], 'productionRoot': str(root), 'configFile': str(config_file),
        'stateDb': str(db_file), 'stopRequested': Path(paths['stop_file']).exists(), 'services': services,
        'meta': meta, 'activeRuns': active, 'git': git, 'slotEvidence': slot_evidence(config)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
