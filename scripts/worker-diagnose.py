#!/usr/bin/env python3
"""Read-only worker diagnosis; never instantiates or migrates the worker store."""
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess

home = Path.home()
plist = home / 'Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist'
with plist.open('rb') as f:
    service = plistlib.load(f)
args = service['ProgramArguments']
node = next(a for a in args if Path(a).name == 'node')
root = Path(service['WorkingDirectory'])
config_file = Path(args[args.index('--config') + 1])
script = "const{loadConfig}=require(process.argv[1]+'/src/config.js');const c=loadConfig(process.argv[2],{root:process.argv[1]});console.log(JSON.stringify({workerId:c.worker_id,paths:c.paths}));"
config = json.loads(subprocess.check_output([node, '-e', script, str(root), str(config_file)], text=True))
paths = config['paths']
db_file = Path(paths['state_db']).resolve()
db = sqlite3.connect(db_file.as_uri() + '?mode=ro', uri=True, timeout=5)
meta = {}
for key in ['last_poll', 'worker_control', 'monitor_admission', 'claude_auslastung', 'claude_ausfall',
            'last_update', 'rs_hub_mcp_update_failed', 'rs_hub_mcp_last_update']:
    row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    try:
        meta[key] = json.loads(row[0]) if row else None
    except ValueError:
        meta[key] = {'invalid_json': True}
active = [dict(zip(['runId', 'taskId', 'title', 'state', 'pid'], row)) for row in db.execute(
    "SELECT run_id,task_id,task_name,state,pid FROM runs WHERE state IN ('queued','running','paused') ORDER BY queued_at")]
db.close()
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
    'meta': meta, 'activeRuns': active, 'git': git}, ensure_ascii=False, indent=2))
