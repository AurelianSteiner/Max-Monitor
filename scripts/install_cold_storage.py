#!/usr/bin/env python3
"""Install a separate bounded cold-archive timer without restarting production."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

TARGET = Path('/opt/max-monitor-cold-storage')
FILES = ('auto_cold_storage.py', 'cold_history.py', 'mount_cold_history.py', 'install_cold_storage.py')
SERVICE = '''[Unit]
Description=Losslessly compress completed, quiescent RS Hub archives
After=local-fs.target
ConditionPathIsDirectory=/opt/rs-hub

[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/python3 /opt/max-monitor-cold-storage/auto_cold_storage.py
WorkingDirectory=/opt/max-monitor-cold-storage
UMask=0077
Nice=19
IOSchedulingClass=idle
IOWeight=10
CPUQuota=200%
MemoryMax=8G
TimeoutStartSec=12h
TimeoutStopSec=60
KillMode=control-group
NoNewPrivileges=true
RestrictSUIDSGID=true
LockPersonality=true
# Mounts must propagate to the existing services. Do not enable PrivateTmp,
# ProtectSystem, ProtectHome or other options that create a mount namespace.
'''
TIMER = '''[Unit]
Description=Check new cold RS Hub archives every six hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:35:00 UTC
RandomizedDelaySec=5m
Persistent=true
Unit=max-monitor-cold-storage.service

[Install]
WantedBy=timers.target
'''


def units():
    return {'max-monitor-cold-storage.service': SERVICE, 'max-monitor-cold-storage.timer': TIMER}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--install', action='store_true')
    mode.add_argument('--generate-only', type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    os.umask(0o077)
    manifest = {'files': {name: hashlib.sha256((args.source/name).read_bytes()).hexdigest() for name in FILES},
                'service': 'max-monitor-cold-storage.service', 'timer': 'max-monitor-cold-storage.timer'}
    if args.generate_only:
        args.generate_only.mkdir(mode=0o700, parents=True, exist_ok=False)
        for name, text in units().items():
            (args.generate_only/name).write_text(text)
        (args.generate_only/'manifest.json').write_text(json.dumps(manifest, indent=2))
    else:
        if os.geteuid() != 0 or not Path('/opt/rs-hub').is_dir():
            parser.error('Requires the existing RS Hub administrator')
        for tool in ('mksquashfs', 'mount', 'umount', 'findmnt', 'nsenter'):
            if not shutil.which(tool):
                parser.error('Required installed tool is missing: '+tool)
        status=subprocess.check_output(['systemctl','show','max-monitor-cold-storage.service','-p','ActiveState','--value'],text=True).strip()
        if status in ('active','activating','reloading','deactivating'):
            parser.error('The compression service is busy; retry after it finishes')
        state=Path('/var/lib/max-monitor-cold-storage')
        state.mkdir(mode=0o700,parents=True,exist_ok=True)
        lock=(state/'run.lock').open('a')
        try:
            fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('A compression run owns the installation lock; retry after it finishes')
        backup = Path('/var/backups/max-monitor-cold-storage')/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        TARGET.mkdir(mode=0o700, parents=True, exist_ok=True)
        targets = {TARGET/name: (args.source/name).read_bytes() for name in FILES}
        targets.update({Path('/etc/systemd/system')/name: text.encode() for name,text in units().items()})
        for target, data in targets.items():
            if target.exists():
                shutil.copy2(target, backup/target.name)
            temporary = target.with_suffix('.install.tmp')
            temporary.write_bytes(data); temporary.chmod(0o644); temporary.replace(target)
        subprocess.run(['systemd-analyze','verify',*[str(Path('/etc/systemd/system')/name) for name in units()]],check=True)
        subprocess.run(['systemctl','daemon-reload'],check=True)
        subprocess.run(['systemctl','enable','--now','max-monitor-cold-storage.timer'],check=True)
        manifest['backup'] = str(backup)
        (backup/'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
