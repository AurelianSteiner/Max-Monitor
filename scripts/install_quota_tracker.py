#!/usr/bin/env python3
"""Install only the passive quota collector; never restart newsletter workers."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from quota_routing import hub_runtime

SERVICE = "max-monitor-quota.service"
UNIT = """[Unit]
Description=Max Monitor passive Claude quota and task ledger
After=max-monitor-relay.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/max-monitor-quota
ExecStart=/usr/bin/python3 /opt/max-monitor-quota/quota_ledger.py serve --interval 15 --output /var/lib/max-monitor-quota/reports
Restart=on-failure
RestartSec=10
TimeoutStopSec=15
StateDirectory=max-monitor-quota
StateDirectoryMode=0755
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/var/lib/max-monitor
ReadWritePaths=/var/lib/max-monitor-quota

[Install]
WantedBy=multi-user.target
"""

WATCHDOG_UNIT = """[Unit]
Description=Recover stale passive Max Monitor quota output
After=max-monitor-quota.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/max-monitor-quota/quota_watchdog.py
TimeoutStartSec=60
StateDirectory=max-monitor-quota-watchdog
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/var/lib/max-monitor-quota/public
ReadWritePaths=/var/lib/max-monitor-quota-watchdog
"""

WATCHDOG_TIMER = """[Unit]
Description=Check actual Max Monitor quota freshness every 30 seconds

[Timer]
OnBootSec=45
OnUnitActiveSec=30
AccuracySec=5
Unit=max-monitor-quota-watchdog.service

[Install]
WantedBy=timers.target
"""


def units():
    return {SERVICE: unit_text(), "max-monitor-quota-watchdog.service": WATCHDOG_UNIT,
            "max-monitor-quota-watchdog.timer": WATCHDOG_TIMER}


def unit_text():
    # SQLite's read-only WAL readers may need to initialize coordination
    # sidecars. Keep the database and an existing WAL mounted read-only;
    # allow sidecar creation only in this one register directory.
    register = hub_runtime() / 'state/worker-reservations'
    if not all(c.isalnum() or c in '/._-' for c in str(register)):
        raise ValueError('Unsafe reservation path')
    return UNIT.replace('ReadWritePaths=/var/lib/max-monitor-quota',
                        'ReadWritePaths=/var/lib/max-monitor-quota -' + str(register)
                        + '\nReadOnlyPaths=-' + str(register / 'claims.sqlite')
                        + ' -' + str(register / 'claims.sqlite-wal'))


def plan(source):
    source = Path(source)
    return [(source / "quota_ledger.py", Path("/opt/max-monitor-quota/quota_ledger.py")),
            (source / "quota_routing.py", Path("/opt/max-monitor-quota/quota_routing.py")),
            (source / "quota_worker.py", Path("/opt/max-monitor-quota/quota_worker.py")),
            (source / "quota_watchdog.py", Path("/opt/max-monitor-quota/quota_watchdog.py")),
            (source / "quota_archive.py", Path("/opt/max-monitor-quota/quota_archive.py")),
            (source / "install_quota_tracker.py", Path("/opt/max-monitor-quota/install_quota_tracker.py"))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--generate-only")
    parser.add_argument("--source", default=str(Path(__file__).parent))
    args = parser.parse_args()
    if args.install == bool(args.generate_only):
        parser.error("Choose --install or --generate-only <directory>")
    os.umask(0o077)
    files = plan(args.source)
    manifest = {"service": SERVICE, "interval_seconds": 15, "worker_interval_seconds": 60,
                "database": "/var/lib/max-monitor-quota/ledger.sqlite", "files": []}
    for source, target in files:
        manifest["files"].append({"target": str(target), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    if args.generate_only:
        output = Path(args.generate_only)
        output.mkdir(parents=True, exist_ok=False, mode=0o700)
        for name, text in units().items():
            (output / name).write_text(text)
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    else:
        if os.geteuid() != 0:
            parser.error("Installation requires the existing Hub administrator")
        if not Path("/var/lib/max-monitor/RSMACS01/fleet.json").is_file():
            parser.error("Existing Max Monitor Fleet source is missing")
        backup = Path("/var/backups/max-monitor-quota") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup.mkdir(parents=True, exist_ok=False, mode=0o700)
        unit_paths = [Path("/etc/systemd/system") / name for name in units()]
        for target in [t for _, t in files] + unit_paths:
            if target.exists():
                saved = backup / target.name
                shutil.copy2(target, saved)
        for source, target in files:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            temporary = target.with_suffix(".tmp")
            temporary.write_bytes(source.read_bytes())
            os.chmod(temporary, 0o644)
            temporary.replace(target)
        state = Path('/var/lib/max-monitor-quota')
        state.mkdir(parents=True, exist_ok=True)
        os.chmod(state, 0o755)
        public = state / 'public'
        public.mkdir(exist_ok=True)
        os.chmod(public, 0o755)
        for name, text in units().items():
            unit = Path("/etc/systemd/system") / name
            unit.write_text(text)
            os.chmod(unit, 0o644)
        subprocess.run(["/usr/bin/systemd-analyze", "verify", *map(str, unit_paths)], check=True)
        subprocess.run(["/usr/bin/python3", "/opt/max-monitor-quota/quota_ledger.py", "collect"], check=True, capture_output=True)
        subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True)
        subprocess.run(["/usr/bin/systemctl", "enable", "--now", SERVICE], check=True, capture_output=True)
        subprocess.run(["/usr/bin/systemctl", "restart", SERVICE], check=True)
        subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", SERVICE], check=True)
        subprocess.run(["/usr/bin/systemctl", "enable", "--now", "max-monitor-quota-watchdog.timer"], check=True, capture_output=True)
        manifest["backup_directory"] = str(backup)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
