import json
from pathlib import Path
import tempfile
import unittest
import zlib

from test_quota_tracker import NOW, both_windows, module, payload

ledger_module = module('quota_ledger')
backfill = module('sales_usage_backfill')


def completed_sales(at=NOW + 600):
    data = both_windows(at, 14)
    data['queue'] = {'tasks': [{'id': 'sales:123.456', 'workflow': 'sales',
        'status': 'completed', 'completedAt': at, 'url': 'https://exact.example'}]}
    return data


class SalesBackfillTests(unittest.TestCase):
    def test_fleet_closes_orphaned_parts_without_closing_a_later_attempt(self):
        ledger = ledger_module.Ledger(':memory:')
        p = payload()
        parent = {**p['runs'][0], 'task_id': 'sales:123.456', 'kind': 'sales', 'state': 'running', 'finished': None}
        p['runs'] = [parent, {**parent, 'run_id': 'run-a:part:old'},
                     {**parent, 'run_id': 'run-b', 'started': NOW + 900}]
        ledger.ingest(p, NOW + 1000)
        ledger.fleet(completed_sales(), NOW + 1000)
        rows = {r['run_id']: (r['state'], r['finished']) for r in ledger.db.execute('SELECT * FROM runs')}
        self.assertEqual(rows['run-a'], ('completed', NOW + 600))
        self.assertEqual(rows['run-a:part:old'], ('completed', NOW + 600))
        self.assertEqual(rows['run-b'], ('running', None))
        ledger.ingest({**p, 'runs': [p['runs'][-1]], 'events': []}, NOW + 1001)
        self.assertEqual(tuple(ledger.db.execute("SELECT state,finished FROM runs WHERE run_id='run-b'").fetchone()), ('running', None))

    def test_historical_replay_imports_sales_once_and_preserves_other_measurements(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'live.sqlite'
            ledger = ledger_module.Ledger(source)
            ledger.reset(NOW - 1)
            ledger.fleet(both_windows(NOW, 10), NOW)
            p = payload()
            p['runs'][0].update(task_id='sales:123.456', kind='sales', state='running', finished=None, pending_scan=0)
            # Initial collection has metadata but lacks the original stream.
            ledger.ingest({**p, 'events': []}, NOW + 600)
            ledger.fleet(completed_sales(), NOW + 600)
            ledger.dashboard(NOW + 700)
            ledger.dashboard(NOW + 3 * 86400)
            before = ledger.db.execute('SELECT payload FROM compact_jobs').fetchone()[0]
            self.assertEqual(json.loads(zlib.decompress(before))['check'], 'pending_evidence')
            # Retained account counters and parallel work must be replayed too.
            ledger.archive_rows({'samples': [dict(r) for r in ledger.db.execute('SELECT * FROM samples')]}, NOW + 3 * 86400)
            ledger.db.commit()
            target = Path(directory) / 'backfill'
            backfill.prepare(source, target)
            staging = ledger_module.Ledger(target / 'ledger.sqlite')
            staging.ingest({**p, 'sales_replay': True}, NOW + 3 * 86400)
            staging.db.close()
            result = backfill.finish(source, target, completed_sales(), NOW + 3 * 86400)
            self.assertEqual(result['imported'], ['sales:sales:123.456'])
            self.assertEqual(result['staging_sales']['weekly_pp']['mean'], 4)
            self.assertEqual(result['staging_sales']['five_hour_pp']['mean'], 4)
            self.assertEqual(ledger.dashboard(NOW + 3 * 86400)['by_kind'][3]['weekly_pp']['n'], 1)
            result = backfill.finish(source, target, completed_sales(), NOW + 3 * 86400)
            self.assertEqual(result['imported'], [])
            self.assertEqual(result['preserved_complete'], ['sales:sales:123.456'])
            self.assertTrue((target / 'before.sqlite').is_file())
            self.assertTrue((target / 'before-import.sqlite').is_file())

    def test_replay_flag_cannot_bypass_live_retention(self):
        ledger = ledger_module.Ledger(':memory:')
        with self.assertRaisesRegex(ValueError, 'isolated'):
            ledger.ingest({**payload(), 'sales_replay': True}, NOW + 600)


if __name__ == '__main__':
    unittest.main()
