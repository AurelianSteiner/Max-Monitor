#!/usr/bin/env python3
"""Existing SSH maintenance release, source only; no enrollment or customer writes."""
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

UNITS = ('max-monitor-relay.service', 'max-monitor-queue.service')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def safe_path(value):
    return isinstance(value, str) and re.fullmatch(r'(?:(?:team-server|scripts)/[A-Za-z0-9_.-]+|team-server/public/[A-Za-z0-9_-]+\.(?:html|css|js))', value) and '..' not in value


def install(payload, root=Path('/opt/max-monitor'), backup_root=Path('/var/backups/max-monitor'),
            run=subprocess.run, dry_run=False):
    revision = payload.get('revision', '')
    files, baseline = payload.get('files', {}), payload.get('baseline', {})
    allowed = payload.get('manifest', {})
    if not re.fullmatch(r'[a-f0-9]{40}', revision) or allowed.get('schema') != 1:
        raise ValueError('Invalid immutable release')
    if set(files) != set(allowed.get('files', [])) or not files or not all(safe_path(p) for p in set(files) | set(baseline)):
        raise ValueError('Invalid source manifest')
    if not set(files).issubset(baseline):
        raise ValueError('Missing preflight baseline')
    for rel, previous in baseline.items():
        if (root / rel).is_symlink() or digest(root / rel) != previous:
            raise ValueError('Live source changed: ' + rel)
    decoded = {}
    for rel, entry in files.items():
        data = base64.b64decode(entry['base64'], validate=True)
        if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Invalid staged digest: ' + rel)
        decoded[rel] = data
    if dry_run:
        return {'ok': True, 'dryRun': True, 'sourceRevision': revision, 'files': len(files)}

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = backup_root / ('runtime-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    previous, installed = {}, {}
    active = []
    for unit in UNITS:
        if run(['systemctl', 'is-active', '--quiet', unit], capture_output=True).returncode == 0:
            active.append(unit)
    receipt = root / 'relay-release.json'
    paths = list(files) + ['relay-release.json']
    for rel in paths:
        p = root / rel
        if p.is_symlink():
            raise ValueError('Unexpected source symlink')
        previous[rel] = digest(p)
        if p.exists():
            dest = backup / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dest)
    preserved = {rel: sha for rel, sha in baseline.items() if rel not in files}
    manifest = {'schema': 2, 'component': 'monitor-runtime', 'sourceRevision': revision, 'verifiedSource': True,
                'sourceFiles': {p: v['sha256'] for p, v in files.items()},
                'preservedHelpers': preserved, 'installedAt': stamp, 'backupDirectory': str(backup)}
    (backup / 'before.json').write_text(json.dumps(previous, indent=2) + '\n')
    try:
        # A syntax failure is discovered before replacing any live source.
        with tempfile.TemporaryDirectory(prefix='max-monitor-source-') as staged:
            for rel, data in decoded.items():
                p = Path(staged) / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                if p.suffix in ('.js', '.mjs', '.cjs'):
                    run(['node', '--check', str(p)], check=True, capture_output=True)
                elif p.suffix == '.json':
                    json.loads(data)
            for rel, previous_hash in baseline.items():
                if digest(root / rel) != previous_hash:
                    raise ValueError('Live source changed during staging: ' + rel)
            for rel, data in decoded.items():
                p = root / rel
                temporary = p.with_name(p.name + '.release-' + stamp)
                temporary.write_bytes(data)
                temporary.chmod(p.stat().st_mode & 0o777 if p.exists() else 0o644)
                if p.exists() and os.geteuid() == 0:
                    s = p.stat()
                    os.chown(temporary, s.st_uid, s.st_gid)
                os.replace(temporary, p)
                installed[rel] = files[rel]['sha256']
        receipt.write_text(json.dumps(manifest, indent=2) + '\n')
        receipt.chmod(0o644)
        installed['relay-release.json'] = digest(receipt)
        for unit in active:
            run(['systemctl', 'restart', unit], check=True, capture_output=True)
            run(['systemctl', 'is-active', '--quiet', unit], check=True, capture_output=True)
        for rel, sha in manifest['sourceFiles'].items():
            if digest(root / rel) != sha:
                raise ValueError('Installed source drift: ' + rel)
        for rel, sha in preserved.items():
            if digest(root / rel) != sha:
                raise ValueError('Unrelated helper drift: ' + rel)
        return {'ok': True, **manifest, 'restartedMonitorUnits': active,
                'newsletterWorkersRestarted': False, 'customerWrites': 0}
    except BaseException:
        # Never overwrite bytes replaced by another operator after our mutation.
        for rel, own_hash in installed.items():
            p = root / rel
            if digest(p) != own_hash:
                continue
            if previous[rel] is None:
                p.unlink(missing_ok=True)
            else:
                shutil.copy2(backup / rel, p)
        for unit in active:
            run(['systemctl', 'restart', unit], check=True, capture_output=True)
        raise


if __name__ == '__main__':
    payload = json.load(sys.stdin)
    with open('/run/lock/max-monitor-code-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(install(payload, dry_run='--dry-run' in sys.argv)))
