#!/usr/bin/env python3
"""Check the configured worker credential in its existing macOS login session.

Run locally on the target through max-monitor-worker exec. No credential is
returned or persisted. Exit 3 means keychain access works but the provider does
not allow this token to disclose its account email.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import tempfile
import time


def worker_context(home):
    with (home/'Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist').open('rb') as file:
        service = plistlib.load(file)
    args = service['ProgramArguments']
    node = next(value for value in args if Path(value).name == 'node')
    root = service['WorkingDirectory']
    config = args[args.index('--config')+1]
    source = "const{loadConfig}=require(process.argv[1]+'/src/config.js');const c=loadConfig(process.argv[2],{root:process.argv[1]});console.log(JSON.stringify({workerId:c.worker_id,db:c.paths.state_db,tokenService:c.claude.token_keychain}));"
    result = json.loads(subprocess.check_output([node, '-e', source, root, config], text=True, timeout=15))
    state = Path(result['db']).parent/'claude-token.json'
    result['fingerprint'] = json.loads(state.read_text()).get('fingerprint') if state.exists() else None
    return result


def baseline(database):
    service = subprocess.run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/de.ruegamer-steiner.ai-newsletter'],
                             capture_output=True, text=True, timeout=10)
    match = re.search(r'^\s*pid = (\d+)', service.stdout, re.M)
    with sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True, timeout=5) as db:
        active = [{'runId':r[0], 'pid':r[1], 'state':r[2]} for r in db.execute(
            "SELECT run_id,pid,state FROM runs WHERE state IN ('running','queued','paused')")]
    return {'workerPid':int(match.group(1)) if match else None, 'activeRuns':active,
            'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat()}


def classify(probe):
    if probe.get('workerCredentialReadStatus') != 0:
        return 'keychain_access_failed', 1
    if probe.get('credentialMatchesWorkerRecord') is not True:
        return 'worker_token_not_confirmed', 1
    if probe.get('workerProfileStatus') == 403 and probe.get('profileRequiredScope') == 'user:profile':
        return 'blocked_provider_profile_scope', 3
    if probe.get('workerProfileStatus') == 200 and isinstance(probe.get('authenticatedWorkerEmail'), str) and probe['authenticatedWorkerEmail']:
        return 'provider_email_verified', 0
    return 'provider_email_not_verified', 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe-app', type=Path, help='Signed local ClaudeAccountProbe app; defaults to the installed maintenance helper')
    options = parser.parse_args()
    os.umask(0o077)
    home = Path.home()
    install = home/'.local/share/max-monitor-account-check'
    if options.probe_app:
        app = options.probe_app.resolve()
    else:
        app = Path(json.loads((install/'installation.json').read_text())['probeApp']).resolve()
        if not app.is_relative_to(install.resolve()):
            raise RuntimeError('Probe is outside the private maintenance installation')
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
    context = worker_context(home)
    before = baseline(context['db'])
    runs = install/'runs'
    runs.mkdir(parents=True, mode=0o700, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='account-', dir=runs))
    (directory/'context.json').write_text(json.dumps({'workerId':context['workerId'], 'tokenService':context['tokenService'],
        'username':__import__('pwd').getpwuid(os.getuid()).pw_name, 'expectedFingerprint':context['fingerprint']}))
    subprocess.run(['/usr/bin/open', '-g', '-n', str(app), '--args', str(directory)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
    output = directory/'result.json'
    deadline = time.monotonic()+35
    while not output.exists() and time.monotonic() < deadline:
        time.sleep(.1)
    if not output.exists():
        raise RuntimeError('No result from the existing macOS login session')
    probe = json.loads(output.read_text())
    status, exit_code = classify(probe)
    after = baseline(context['db'])
    result = {'schema':1, 'workerId':context['workerId'], 'status':status, 'probe':probe,
        'before':before, 'after':after, 'workerPidUnchanged':before['workerPid'] is not None and before['workerPid']==after['workerPid'],
        'workerCredentialsChanged':False, 'keychainAccessRulesChanged':False,
        'resultFile':str(directory/'verification.json')}
    if not result['workerPidUnchanged']:
        result['concurrentWorkerProcessChange'] = True
        exit_code = 1
    (directory/'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(result, ensure_ascii=False))
    return exit_code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({'error':'account_check_failed', 'kind':type(error).__name__}))
        raise SystemExit(1)
