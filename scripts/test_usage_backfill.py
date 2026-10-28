import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib

from test_quota_tracker import NOW, LOGIN_FIVE, RESET, SECOND_FIVE, module, pool_login_fleet, pool_run

backfill = module('usage_backfill')


class UsageBackfillTests(unittest.TestCase):
    def test_replay_imports_open_pool_measurements_once_and_a_dry_run_changes_nothing(self):
        later = NOW + 3 * 86400
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'live.sqlite'
            ledger = backfill.Ledger(source)
            ledger.reset(NOW - 1)
            ledger.fleet(pool_login_fleet(), NOW)
            # Until 28.10.2026 no stream of a two-account Mac resolved to an account.
            with patch.object(backfill.Ledger, 'resolve', lambda self, *args, **kwargs: None):
                ledger.ingest(pool_run('run-login', LOGIN_FIVE, RESET, 10), NOW + 1000)
                ledger.ingest(pool_run('run-second', SECOND_FIVE, RESET + 3600, 20), NOW + 1000)
                ledger.dashboard(NOW + 1000)
                ledger.dashboard(later)
            def checks():
                return {r['job']: json.loads(zlib.decompress(r['payload']))['check']
                        for r in ledger.db.execute('SELECT * FROM compact_jobs')}
            self.assertEqual(set(checks().values()), {'pending_evidence'})
            self.assertEqual(ledger.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0, 'raw rows are archived')
            target = Path(directory) / 'backfill'
            backfill.prepare(source, target)
            dry = backfill.finish(source, target, pool_login_fleet(), later, dry_run=True)
            self.assertEqual(sorted(dry['imported']), ['newsletter:run-login@1', 'newsletter:run-second@1'])
            self.assertEqual(set(checks().values()), {'pending_evidence'}, 'a dry run writes nothing')
            self.assertFalse((target / 'before-import.sqlite').exists())
            result = backfill.finish(source, target, pool_login_fleet(), later)
            self.assertEqual(result['imported_by_kind'], {'newsletter': 2})
            self.assertEqual(set(checks().values()), {'complete'})
            newsletter = next(r for r in ledger.dashboard(later)['by_kind'] if r['key'] == 'newsletter')
            self.assertEqual((newsletter['five_hour_pp']['n'], newsletter['five_hour_pp']['mean'], newsletter['pending']), (2, 4, 0))
            again = backfill.finish(source, target, pool_login_fleet(), later)
            self.assertEqual((again['imported'], sorted(again['preserved_complete'])),
                             ([], ['newsletter:run-login@1', 'newsletter:run-second@1']))
            self.assertTrue((target / 'before.sqlite').is_file())
            self.assertTrue((target / 'before-import.sqlite').is_file())
            ledger.db.close()

    def test_entry_recomputed_live_after_prepare_is_left_alone(self):
        later = NOW + 3 * 86400
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'live.sqlite'
            ledger = backfill.Ledger(source)
            ledger.reset(NOW - 1)
            ledger.fleet(pool_login_fleet(), NOW)
            with patch.object(backfill.Ledger, 'resolve', lambda self, *args, **kwargs: None):
                ledger.ingest(pool_run('run-login', LOGIN_FIVE, RESET, 10), NOW + 1000)
                ledger.dashboard(NOW + 1000)
                ledger.dashboard(later)
            target = Path(directory) / 'backfill'
            backfill.prepare(source, target)
            row = ledger.db.execute('SELECT * FROM compact_jobs').fetchone()
            entry = {**json.loads(zlib.decompress(row['payload'])), 'title': 'changed'}
            with ledger.db:
                ledger.db.execute('UPDATE compact_jobs SET payload=?', (zlib.compress(json.dumps(entry).encode(), 9),))
            result = backfill.finish(source, target, pool_login_fleet(), later)
            self.assertEqual((result['imported'], result['skipped']), ([], {'newsletter:run-login@1': 'changed_live'}))
            ledger.db.close()

    def test_replay_may_add_earlier_attempts_but_never_change_the_completion(self):
        old = {'kind': 'newsletter', 'finished': '2026-10-26T10:00:00Z', 'workers': ['mac-1']}
        self.assertTrue(backfill.same_completion(old, {**old, 'workers': ['mac-1', 'mac-2']}))
        self.assertFalse(backfill.same_completion(old, {**old, 'workers': ['mac-2']}))
        self.assertFalse(backfill.same_completion(old, {**old, 'finished': '2026-10-26T11:00:00Z'}))
        self.assertFalse(backfill.same_completion(old, {**old, 'kind': 'correction'}))


if __name__ == '__main__':
    unittest.main()
