import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('worker_diagnose', Path(__file__).with_name('worker-diagnose.py'))
diag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diag)


class DiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.main = self.root / 'worker.sqlite'
        self.config = {'paths': {'state_db': str(self.main)}, 'browserEnabled': True}

    def database(self, path, rows=()):
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path)
        db.executescript('CREATE TABLE runs(run_id TEXT, task_id TEXT, state TEXT, pid INTEGER, task_name TEXT, queued_at TEXT);'
                         'CREATE TABLE meta(key TEXT, value TEXT);')
        db.executemany('INSERT INTO runs(run_id,task_id,state,pid) VALUES(?,?,?,?)', rows)
        db.commit()
        db.close()

    def receipt(self, name, value):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value) if not isinstance(value, str) else value)

    def test_paused_and_duplicate_runs_do_not_hold_places(self):
        self.database(self.main, [('a', 'task-a', 'running', 11), ('b', 'task-b', 'paused', None)])
        self.database(self.root / 'sales-live-test/worker.sqlite', [('a', 'task-a', 'running', 11), ('c', 'task-c', 'queued', None)])
        result = diag.slot_evidence(self.config)
        self.assertEqual(result['occupiedTasks'], 2)
        self.assertEqual([e['reason'] for e in result['entries']], ['running_run', 'paused_run', 'duplicate_run', 'queued_run'])

    def test_all_receipt_kinds_and_unknown_receipts_follow_conservative_counts(self):
        self.database(self.main)
        self.receipt('sales-active.json', {'owner': 'owner-a', 'parked': True, 'token': 'never-export'})
        self.receipt('sales-active-2.json', '{incomplete')
        self.receipt('sales-active-3.json', {'owner': 'owner-b', 'state': 'building'})
        self.receipt('weekly-preview-active.json', '{incomplete')
        self.receipt('klaviyo-browser/owner.json', {'jobId': 'timer:1', 'pid': 71, 'token': 'never-export', 'nested': {'password': 'never-export'}})
        result = diag.slot_evidence(self.config)
        self.assertEqual(result['occupiedTasks'], 4)
        self.assertEqual(sum(e['counted'] for e in result['entries'] if e['kind'] == 'sales'), 2)
        self.assertNotIn('never-export', json.dumps(result))
        self.assertNotIn('token', json.dumps(result))

    def test_disabled_browser_requires_same_live_process(self):
        self.config['browserEnabled'] = False
        self.receipt('klaviyo-browser/owner.json', {'jobId': 'feed:1', 'pid': 71, 'processStart': 'original'})
        self.assertEqual(diag.slot_evidence(self.config, lambda pid: 'original')['occupiedTasks'], 1)
        self.assertEqual(diag.slot_evidence(self.config, lambda pid: 'reused-pid')['occupiedTasks'], 0)
        self.assertEqual(diag.slot_evidence(self.config, lambda pid: None)['occupiedTasks'], 0)
        self.assertTrue((self.root / 'klaviyo-browser/owner.json').exists())

    def test_missing_database_does_not_create_it_and_missing_meta_is_null(self):
        self.assertEqual(diag.slot_evidence(self.config)['occupiedTasks'], 0)
        self.assertFalse(self.main.exists())
        self.database(self.main)
        meta, active = diag.read_state(self.main)
        self.assertTrue(all(v is None for v in meta.values()))
        self.assertEqual(active, [])
        self.assertFalse((self.root / 'sales-live-test').exists())

    def test_unknown_schema_is_reported_and_does_not_prove_consistency(self):
        with sqlite3.connect(self.main) as db:
            db.execute('CREATE TABLE other(value TEXT)')
        self.config['authoritativeOccupiedTasks'] = 0
        result = diag.slot_evidence(self.config)
        self.assertIsNone(result['consistent'])
        self.assertEqual(result['issues'], [{'workspace': 'main', 'reason': 'database_unreadable'}])

    def test_mac_state_database_and_separate_workspace_are_the_physical_root(self):
        self.config['macStateDb'] = str(self.root / 'shared/worker.sqlite')
        self.database(Path(self.config['macStateDb']), [('shared', 'task', 'running', 1)])
        self.database(self.main, [('isolated-other', 'task', 'running', 2)])
        result = diag.slot_evidence(self.config)
        self.assertEqual(result['occupiedTasks'], 1)
        self.assertEqual(result['entries'][0]['runId'], 'shared')

    def test_token_fingerprint_and_invalid_meta_are_sanitized_without_writes(self):
        self.database(self.main)
        with sqlite3.connect(self.main) as db:
            db.execute('INSERT INTO meta VALUES(?,?)', ('claude_auslastung', json.dumps({'ok': True, 'token': 'fingerprint'})))
            db.execute('INSERT INTO meta VALUES(?,?)', ('last_poll', '{bad'))
        before = self.main.read_bytes()
        meta, _ = diag.read_state(self.main)
        self.assertEqual(meta['claude_auslastung'], {'ok': True})
        self.assertEqual(meta['last_poll'], {'invalid_json': True})
        self.assertEqual(before, self.main.read_bytes())

    @unittest.skipUnless(shutil.which('node'), 'node is needed for independent counter comparison')
    def test_fixture_counter_matches_actual_worker_counter(self):
        worker = Path(os.environ.get('AI_NEWSLETTER_CREATION_DIR', Path.home() / 'Documents/AI Newsletter Creation'))
        if not (worker / 'src/mac-capacity.js').is_file():
            self.skipTest('current audit worker checkout is unavailable')
        self.database(self.main, [('running', 'task', 'running', 1), ('paused', 'other', 'paused', None)])
        self.database(self.root / 'sales-live-test/worker.sqlite', [('running', 'task', 'running', 1)])
        self.receipt('sales-active.json', {'owner': 'parked', 'parked': True})
        self.receipt('sales-active-2.json', '{unknown')
        self.receipt('weekly-preview-active.json', {})
        self.receipt('klaviyo-browser/owner.json', {})
        config = {'paths': {'state_db': str(self.main)}, 'klaviyo_browser': {'enabled': True}}
        script = "const c=JSON.parse(process.argv[1]);console.log(require(process.argv[2]).occupiedMacTasks(c))"
        actual = int(subprocess.check_output(['node', '-e', script, json.dumps(config), str(worker / 'src/mac-capacity.js')], text=True))
        self.config['authoritativeOccupiedTasks'] = actual
        before = {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = diag.slot_evidence(self.config)
        self.assertEqual(result['occupiedTasks'], actual)
        self.assertTrue(result['consistent'])
        self.assertEqual(before, {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})


if __name__ == '__main__':
    unittest.main()
