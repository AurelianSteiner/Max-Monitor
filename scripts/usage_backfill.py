#!/usr/bin/env python3
"""Replay retained evidence of every task kind in isolation; import only new complete measurements."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import zlib

from quota_ledger import KINDS, Ledger
from sales_usage_backfill import readonly, restore_archives


def prepare(source, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    with closing(readonly(source)) as live, closing(sqlite3.connect(directory / 'before.sqlite')) as backup:
        live.backup(backup)
    with closing(readonly(directory / 'before.sqlite', immutable=True)) as backup, closing(sqlite3.connect(directory / 'ledger.sqlite')) as staging:
        backup.backup(staging)
    ledger = Ledger(directory / 'ledger.sqlite')
    baseline = {r['job']: hashlib.sha256(r['payload']).hexdigest()
                for r in ledger.db.execute('SELECT * FROM compact_jobs')}
    ledger.meta('usage_backfill_staging', True)
    ledger.meta('usage_backfill_baseline', baseline)
    ledger.db.commit()
    restored = restore_archives(ledger)
    ledger.db.close()
    return {'ok': True, 'staging': str(directory / 'ledger.sqlite'), 'restored': restored}


def same_completion(old, entry):
    """Same task kind and completion; the replay may see earlier attempts.

    The live entry knows only the attempts of its 48-hour window. The replay
    keeps every attempt of the task together, so its Macs may only add to them.
    """
    return (old.get('kind') == entry.get('kind') and old.get('finished') == entry.get('finished')
            and set(old.get('workers') or ()) <= set(entry.get('workers') or ()))


def finish(source, directory, fleet, now=None, dry_run=False):
    """Import a replayed entry only where the live one is still incomplete.

    A live entry that changed after prepare was recomputed by the running
    ledger itself and is left alone, like any entry whose completion identity
    or retained usage differs from the replay.
    """
    now = time.time() if now is None else now
    staging = Ledger(Path(directory) / 'ledger.sqlite')
    if not staging.setting('usage_backfill_staging'):
        raise ValueError('Not an isolated usage backfill')
    # Include source rows archived by the current observer during the export.
    restore_archives(staging)
    staging.fleet(fleet, now)
    summary = staging.dashboard(now, replay_kinds=KINDS)
    baseline = staging.setting('usage_backfill_baseline')
    candidates = []
    for row in staging.db.execute('SELECT * FROM compact_jobs'):
        entry = json.loads(zlib.decompress(row['payload']))
        if entry['check'] == 'complete':
            candidates.append((dict(row), entry))
    # A dry run only reads the live ledger and takes no write lock.
    ledger = None if dry_run else Ledger(source)
    live = readonly(source) if dry_run else ledger.db
    live.row_factory = sqlite3.Row
    since = live.execute("SELECT value FROM metadata WHERE key='tracking_since'").fetchone()
    if (json.loads(since[0]) if since else None) != staging.setting('tracking_since'):
        raise ValueError('Tracking epoch changed during backfill')
    if not dry_run:
        backup = Path(directory) / 'before-import.sqlite'
        if not backup.exists():
            with backup.open('xb'):
                pass
            with closing(sqlite3.connect(backup)) as copy:
                live.backup(copy)
    imported, preserved, skipped = [], [], {}
    with live:
        if not dry_run:
            live.execute('BEGIN IMMEDIATE')
        previous = []
        for row, entry in candidates:
            current = live.execute('SELECT * FROM compact_jobs WHERE job=?', (row['job'],)).fetchone()
            if not current:
                skipped[row['job']] = 'not_compacted_live'
                continue
            old = json.loads(zlib.decompress(current['payload']))
            if old['check'] == 'complete':
                preserved.append(row['job'])
                continue
            reason = ('changed_live' if hashlib.sha256(current['payload']).hexdigest() != baseline.get(row['job'])
                      else 'completion_identity' if not same_completion(old, entry)
                      else 'lost_usage' if any(entry['token_counts'][k] < v for k, v in old['token_counts'].items())
                      else None)
            if reason:
                skipped[row['job']] = reason
                continue
            previous.append({'job': row['job'], 'finished': current['finished'], 'entry': old})
            if not dry_run:
                live.execute('INSERT OR REPLACE INTO compact_jobs VALUES(?,?,?)',
                             (row['job'], row['finished'], row['payload']))
            imported.append(row['job'])
        if not dry_run:
            ledger.archive_rows({'usage_backfill_previous': previous}, now)
            if imported:
                ledger.averages_changed('usage_backfill')
    kinds = {}
    for job in imported:
        kind = job.split(':', 1)[0]
        kinds[kind] = kinds.get(kind, 0) + 1
    result = {'ok': True, 'dry_run': dry_run, 'imported': imported, 'imported_by_kind': kinds,
              'preserved_complete': preserved, 'skipped': skipped, 'staging_by_kind': summary['by_kind']}
    staging.db.close()
    live.close()
    if not dry_run:
        (Path(directory) / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'finish'))
    parser.add_argument('--db', default='/var/lib/max-monitor-quota/ledger.sqlite')
    parser.add_argument('--directory', required=True)
    parser.add_argument('--fleet', default='/var/lib/max-monitor/RSMACS01/fleet.json')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    result = prepare(args.db, args.directory) if args.command == 'prepare' else finish(
        args.db, args.directory, json.loads(Path(args.fleet).read_text()), dry_run=args.dry_run)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
