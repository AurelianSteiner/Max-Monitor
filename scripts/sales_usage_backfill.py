#!/usr/bin/env python3
"""Replay retained Sales evidence in isolation; import only verified task sums."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import zlib

from quota_archive import records
from quota_ledger import Ledger, stamp

TABLES = ('runs', 'events', 'samples', 'usage_features', 'tool_usage')


def readonly(filename, immutable=False):
    return sqlite3.connect(Path(filename).resolve().as_uri() + '?mode=ro'
                           + ('&immutable=1' if immutable else ''), uri=True)


def restore_archives(ledger):
    """Restore all parallel work too, preserving allocation denominators."""
    restored = {table: 0 for table in TABLES}
    for raw in records(ledger.db):
        tables = json.loads(raw).get('tables', {})
        for table in TABLES:
            columns = [r[1] for r in ledger.db.execute('PRAGMA table_info(' + table + ')')]
            for row in tables.get(table, []):
                if set(row) != set(columns):
                    raise ValueError('Archived source schema mismatch: ' + table)
                sql = 'INSERT OR IGNORE INTO ' + table + ' VALUES(' + ','.join('?' for _ in columns) + ')'
                restored[table] += ledger.db.execute(sql, [row[k] for k in columns]).rowcount
    ledger.db.commit()
    return restored


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
    ledger.meta('sales_backfill_staging', True)
    ledger.meta('sales_backfill_baseline', baseline)
    ledger.db.commit()
    restored = restore_archives(ledger)
    ledger.db.close()
    return {'ok': True, 'staging': str(directory / 'ledger.sqlite'), 'restored': restored}


def finish(source, directory, fleet, now=None):
    now = time.time() if now is None else now
    staging = Ledger(Path(directory) / 'ledger.sqlite')
    if not staging.setting('sales_backfill_staging'):
        raise ValueError('Not an isolated Sales backfill')
    # Include source rows archived by the current observer during the export.
    restore_archives(staging)
    staging.fleet(fleet, now)
    summary = staging.dashboard(now, replay_sales=True)
    baseline = staging.setting('sales_backfill_baseline')
    candidates = []
    for row in staging.db.execute('SELECT * FROM compact_jobs'):
        entry = json.loads(zlib.decompress(row['payload']))
        if entry['kind'] == 'sales' and entry['check'] == 'complete':
            candidates.append((dict(row), entry))
    live = Ledger(source)
    if live.setting('tracking_since') != staging.setting('tracking_since'):
        raise ValueError('Tracking epoch changed during backfill')
    backup = Path(directory) / 'before-import.sqlite'
    if not backup.exists():
        with backup.open('xb'):
            pass
        with closing(sqlite3.connect(backup)) as copy:
            live.db.backup(copy)
    imported, preserved = [], []
    with live.db:
        live.db.execute('BEGIN IMMEDIATE')
        previous = []
        for row, entry in candidates:
            current = live.db.execute('SELECT * FROM compact_jobs WHERE job=?', (row['job'],)).fetchone()
            if current:
                old = json.loads(zlib.decompress(current['payload']))
                if old['check'] == 'complete':
                    preserved.append(row['job'])
                    continue
                if hashlib.sha256(current['payload']).hexdigest() != baseline.get(row['job']):
                    raise ValueError('Sales measurement changed during backfill: ' + row['job'])
                if old.get('finished') != entry.get('finished') or old.get('workers') != entry.get('workers'):
                    raise ValueError('Sales completion identity changed: ' + row['job'])
                if any(entry['token_counts'][key] < value for key, value in old['token_counts'].items()):
                    raise ValueError('Replay lost existing Sales usage: ' + row['job'])
                previous.append({'job': row['job'], 'finished': current['finished'], 'entry': old})
            task_id = row['job'][len('sales:'):]
            facts = live.setting('task_context', {}).get('task:' + task_id, {})
            if facts.get('state') != 'completed' or stamp(facts.get('finished')) != row['finished']:
                raise ValueError('Sales is no longer confirmed completed: ' + task_id)
            live.db.execute('INSERT OR REPLACE INTO compact_jobs VALUES(?,?,?)',
                            (row['job'], row['finished'], row['payload']))
            imported.append(row['job'])
        live.archive_rows({'sales_backfill_previous': previous}, now)
        if imported:
            live.averages_changed('sales_backfill')
    result = {'ok': True, 'imported': imported, 'preserved_complete': preserved,
              'staging_sales': next(r for r in summary['by_kind'] if r['key'] == 'sales')}
    staging.db.close()
    live.db.close()
    (Path(directory) / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'finish'))
    parser.add_argument('--db', default='/var/lib/max-monitor-quota/ledger.sqlite')
    parser.add_argument('--directory', required=True)
    parser.add_argument('--fleet', default='/var/lib/max-monitor/RSMACS01/fleet.json')
    args = parser.parse_args()
    result = prepare(args.db, args.directory) if args.command == 'prepare' else finish(
        args.db, args.directory, json.loads(Path(args.fleet).read_text()))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
