"""Bounded read-only inputs for the distribution preview; no task content."""
from datetime import datetime
import json
import math
from pathlib import Path
import re
import sqlite3

SLOT_NAMES = ('single', 'primary', 'account-2')
SLOT_STATES = ('ready', 'limited', 'error', 'unknown')
RUN_KINDS = ('newsletter', 'correction', 'upload', 'translation', 'sales')
# The worker's toISOString() form. Stricter than Date.parse in
# validQuotaSlots (src/quota-pacing.js): anything accepted here passes there.
ISO_TIME = re.compile(r'([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})')


def iso_time(value):
    if not isinstance(value, str) or len(value) > 40:
        return False
    match = ISO_TIME.fullmatch(value)
    if not match:
        return False
    try:
        datetime(*map(int, match.groups()[:6]))
    except ValueError:
        return False
    zone = match[7]
    return zone == 'Z' or (int(zone[1:3]) <= 23 and int(zone[4:]) <= 59)


def quota_window(value, reset_required=False):
    return (isinstance(value, dict) and sorted(value) == ['reset', 'used']
            and isinstance(value['used'], (int, float)) and not isinstance(value['used'], bool)
            and 0 <= value['used'] <= 100 and math.isfinite(value['used'])
            and (iso_time(value['reset']) or (value['reset'] is None and not reset_required)))


def quota_identity(value):
    """Provider proof pseudonyms only; parsing never creates an identity."""
    return (isinstance(value, dict) and sorted(value) == ['account', 'organization', 'provider', 'schema', 'source', 'verifiedAt']
            and type(value['schema']) is int and value['schema'] == 1 and value['provider'] == 'anthropic'
            and all(isinstance(value[name], str) and re.fullmatch(r'[0-9a-f]{64}', value[name]) for name in ('account', 'organization'))
            and value['source'] in ('oauth-profile', 'oauth-validate') and iso_time(value['verifiedAt']))


def valid_quota_slots(value):
    """Python twin of validQuotaSlots: 1-2 account slots, <= 12 runs each."""
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        return False
    names = set()
    for slot in value:
        required = {'at', 'five_hour', 'runs', 'seven_day', 'slot', 'status'}
        if not isinstance(slot, dict) or not required.issubset(slot) or set(slot) - required - {'identity', 'blockedUntil', 'statusAt'}:
            return False
        if ('identity' in slot and slot['identity'] is not None and not quota_identity(slot['identity'])
                or 'blockedUntil' in slot and slot['blockedUntil'] is not None and not iso_time(slot['blockedUntil'])
                or 'statusAt' in slot and not iso_time(slot['statusAt'])):
            return False
        if slot['slot'] not in SLOT_NAMES or slot['slot'] in names or slot['status'] not in SLOT_STATES:
            return False
        names.add(slot['slot'])
        runs = slot['runs']
        if (not iso_time(slot['at']) or not quota_window(slot['five_hour']) or not quota_window(slot['seven_day'], True)
                or not isinstance(runs, list) or len(runs) > 12):
            return False
        for run in runs:
            if (not isinstance(run, dict) or not {'kind', 'started'}.issubset(run) or set(run) - {'kind', 'started', 'id', 'identity'}
                    or run['kind'] not in RUN_KINDS
                    or 'id' in run and not (isinstance(run['id'], str) and len(run['id']) <= 300
                                           and re.fullmatch(r'(ordinary|sales|knowledge):[A-Za-z0-9][A-Za-z0-9._@:-]*', run['id']))
                    or 'identity' in run and run['identity'] is not None and not quota_identity(run['identity'])
                    or not (iso_time(run['started']) or run['started'] is None and ('id' in run or 'identity' in run))):
                return False
    return True


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
                if not isinstance(raw, dict) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', str(raw.get('worker_id', '')), re.I):
                    continue
                entry = {k: raw[k] for k in ('worker_id', 'seen_at', 'annahme', 'plaetze', 'occupied_tasks', 'max_tasks') if k in raw}
                # Per-account quota of the worker itself; an invalid field is
                # dropped, never the heartbeat (intake and load stay visible).
                if valid_quota_slots(raw.get('quota_slots')):
                    entry['quota_slots'] = raw['quota_slots']
                fleet.append(entry)
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
