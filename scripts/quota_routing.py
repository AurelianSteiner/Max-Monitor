"""Bounded read-only inputs for the distribution preview; no task content."""
import json
from pathlib import Path
import re
import sqlite3


def hub_runtime(hub=Path('/opt/rs-hub')):
    root = hub
    try:
        for line in (hub / '.env').read_text().splitlines():
            match = re.fullmatch(r'\s*HUB_RUNTIME_DIR\s*=\s*(.*?)\s*', line)
            if match:
                root = Path(match[1].strip('\'"'))
    except OSError:
        pass
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('Invalid Hub runtime path')
    return root


def routing_inputs(hub=Path('/opt/rs-hub')):
    try:
        root = hub_runtime(hub)
    except ValueError:
        return {'available': False}
    fleet, jobs = [], []
    try:
        for file in sorted((root / 'logs/ai-newsletter-fleet').glob('*.json'))[:200]:
            try:
                if file.stat().st_size > 65536:
                    continue
                raw = json.loads(file.read_text())
                if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', str(raw.get('worker_id', '')), re.I):
                    continue
                fleet.append({k: raw[k] for k in ('worker_id', 'seen_at', 'annahme', 'plaetze', 'occupied_tasks', 'max_tasks') if k in raw})
            except (OSError, ValueError, TypeError):
                continue
        register = root / 'state/worker-reservations'
        # An absent register cannot be represented as an empty claims list.
        if not (register / 'enabled').is_file():
            return {'available': False, 'fleet': fleet}
        db = sqlite3.connect((register / 'claims.sqlite').as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            for index, row in enumerate(db.execute('SELECT doc FROM reservations LIMIT 10001')):
                if index >= 10000:
                    return {'available': False, 'fleet': fleet}
                doc = json.loads(row[0])
                if doc.get('state') not in ('claiming', 'running') or doc.get('paused') is True:
                    continue
                task = str(doc.get('taskId', ''))
                kind = ('correction' if task.startswith('korrektur-') else 'translation' if re.search(r'-uebersetzung-(en|it|fr|se|sp)$', task)
                        else 'upload' if task.endswith(('-klaviyo', '-klaviyo-pruefauftrag')) else 'newsletter')
                jobs.append({'worker': str(doc.get('worker', ''))[:80], 'kind': kind})
        finally:
            db.close()
        return {'available': True, 'fleet': fleet, 'jobs': jobs}
    except (OSError, ValueError, sqlite3.Error):
        return {'available': False, 'fleet': fleet}
