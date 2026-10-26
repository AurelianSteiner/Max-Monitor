import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import hashlib
import zlib
import random
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


ledger_module = module("quota_ledger")
worker_module = module("quota_worker")
NOW = 1792350000
RESET = NOW + 86400


def fleet(at, percent, account="a@example.com", worker="mac-1"):
    return {"machines": [{"workerId": worker, "name": worker, "monitoringAccountId": "uuid-" + account,
        "accounts": [{"accountId": "uuid-" + account, "name": account, "provider": "claude", "usageUpdatedAt": at}],
        "limits": [{"accountId": "uuid-" + account, "kind": "weekly", "percent": percent, "resetsAt": RESET, "usageUpdatedAt": at}]}]}


def payload(messages=True):
    return {"schema": 1, "worker": "mac-1", "runs": [{"run_id": "run-a", "task_id": "task-a@1", "title": "A",
        "customer": "Customer", "kind": "newsletter", "started": NOW, "finished": NOW + 600, "state": "fertig"}],
        "events": [{"id": "quota-a", "event_type": "quota", "run_id": "run-a", "at": NOW + 30,
                    "time_quality": "adjacent", "windows": {"seven_day": {"percent": 10, "reset": RESET}}}] +
                   ([{"id": "message-a", "event_type": "message", "run_id": "run-a", "at": NOW + 100,
                      "time_quality": "timestamp", "input_tokens": 10, "output_tokens": 100}] if messages else [])}


def both_windows(at, percent):
    data = fleet(at, percent)
    data['machines'][0]['limits'].append({**data['machines'][0]['limits'][0], 'kind': 'session'})
    return data


def pool_fleet(at=NOW, selected='account-2', worker='mac-1', device='device-a'):
    data = fleet(at, 100, worker=worker)
    data['machines'][0]['deviceId'] = device
    data['workerReports'] = [{'workerId': worker, 'deviceId': device,
        'sampledAt': ledger_module.iso(at), 'receivedAt': ledger_module.iso(at),
        'claudeAccounts': {'selectedAccountId': selected, 'accounts': [
            {'id': 'primary', 'name': 'Claude 1', 'status': 'limited', 'updatedAt': ledger_module.iso(at),
             'windows': [{'kind': 'weekly', 'percent': 100, 'reset': ledger_module.iso(RESET)}]},
            {'id': 'account-2', 'name': 'Claude 2', 'status': 'ready', 'updatedAt': ledger_module.iso(at),
             'windows': [{'kind': 'session', 'percent': 12, 'reset': ledger_module.iso(at + 3600)},
                         {'kind': 'weekly', 'percent': 24, 'reset': ledger_module.iso(RESET + 3600)}]}]}}]
    return data


def bound_machine(worker, account, five_reset, five=50, weekly_reset=RESET, at=NOW, device=None):
    uid = 'uuid-' + account
    machine = {'workerId': worker, 'name': worker, 'monitoringAccountId': uid,
               'accounts': [{'accountId': uid, 'name': account, 'provider': 'claude', 'usageUpdatedAt': at}],
               'limits': [{'accountId': uid, 'kind': 'weekly', 'percent': 40, 'resetsAt': weekly_reset, 'usageUpdatedAt': at},
                          {'accountId': uid, 'kind': 'session', 'percent': five, 'resetsAt': five_reset, 'usageUpdatedAt': at}]}
    if device:
        machine['deviceId'] = device
    return machine


def pool_report(worker, device, account_2_five, at=NOW, weekly_reset=RESET):
    iso = ledger_module.iso
    return {'workerId': worker, 'deviceId': device, 'sampledAt': iso(at), 'receivedAt': iso(at),
            'claudeAccounts': {'selectedAccountId': 'account-2', 'accounts': [
                {'id': 'primary', 'name': 'Claude 1', 'status': 'ready', 'updatedAt': iso(at),
                 'windows': [{'kind': 'weekly', 'percent': 60, 'reset': iso(weekly_reset + 7200)}]},
                {'id': 'account-2', 'name': 'Claude 2', 'status': 'ready', 'updatedAt': iso(at),
                 'windows': [{'kind': 'session', 'percent': 90, 'reset': iso(account_2_five)},
                             {'kind': 'weekly', 'percent': 30, 'reset': iso(weekly_reset)}]}]}}


def stream(worker, five_reset, run, at=NOW + 60, five=94, weekly_reset=RESET):
    windows = {'seven_day': {'percent': 30, 'reset': weekly_reset}}
    if five_reset is not None:
        windows['five_hour'] = {'percent': five, 'reset': five_reset}
    return {'schema': 1, 'worker': worker, 'runs': [{'run_id': run, 'task_id': run + '@1', 'title': 'T', 'customer': 'C',
                                                     'kind': 'newsletter', 'started': NOW, 'state': 'running'}],
            'events': [{'id': 'quota-' + run, 'event_type': 'quota', 'run_id': run, 'at': at,
                        'time_quality': 'timestamp', 'windows': windows}]}


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.ledger = ledger_module.Ledger(":memory:")

    def test_binary_lookup_preserves_linear_results_including_ambiguous_ties(self):
        rng = random.Random(11)
        for _ in range(200):
            rows = sorted([(rng.randrange(8000), rng.choice(['a','b',None])) for _ in range(50)], key=lambda q:q[0])
            rows += [(rows[-1][0], None)]
            at = rng.randrange(12000)
            nearby = [q for q in rows if abs(q[0]-at) <= 1800]
            expected = min(nearby, key=lambda q: abs(q[0]-at)) if nearby else None
            self.assertEqual(ledger_module.nearest_observation(rows, [q[0] for q in rows], at), expected)
        rows = [(0,None),(0,'a'),(100,'b')]
        self.assertEqual(ledger_module.nearest_observation(rows,[0,0,100],50),(0,None))

    def test_archive_export_verifies_the_complete_original_record(self):
        archive = module('quota_archive')
        expected = {'events': [{'id': 'original', 'windows': '{"full":"ä"}', 'output_tokens': 17}]}
        self.ledger.archive_rows(expected, NOW)
        self.ledger.db.commit()
        raw = list(archive.records(self.ledger.db))
        self.assertEqual(json.loads(raw[0])['tables'], expected)
        self.ledger.db.execute("UPDATE raw_archives SET payload=?", (zlib.compress(b'corrupted'),))
        with self.assertRaises(ValueError):
            list(archive.records(self.ledger.db))

    def test_pruned_raw_data_remains_complete_and_losslessly_exportable(self):
        self.ledger.reset(NOW-1)
        self.ledger.fleet(fleet(NOW, 10), NOW)
        self.ledger.ingest(payload(), NOW+600)
        self.ledger.fleet(fleet(NOW+600, 14), NOW+600)
        self.ledger.dashboard(NOW+700)
        expected = {table: [dict(r) for r in self.ledger.db.execute('SELECT * FROM '+table)]
                    for table in ('events','runs','samples')}
        self.ledger.dashboard(NOW+3*86400)
        archived = {table: [] for table in expected}
        for row in self.ledger.db.execute('SELECT * FROM raw_archives'):
            raw = zlib.decompress(row['payload'])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row['id'])
            self.assertEqual(len(raw), row['raw_bytes'])
            for table, values in json.loads(raw)['tables'].items():
                if table in archived:
                    archived[table].extend(values)
        for table, values in expected.items():
            remaining = [dict(r) for r in self.ledger.db.execute('SELECT * FROM '+table)]
            for value in values:
                self.assertIn(value, archived[table]+remaining)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)

    def test_archive_failure_never_removes_raw_evidence(self):
        self.ledger.reset(NOW-1)
        self.ledger.ingest(payload(), NOW+600)
        expected = [dict(r) for r in self.ledger.db.execute('SELECT * FROM events')]
        with patch.object(self.ledger, 'archive_rows', side_effect=ValueError('archive failed')):
            with self.assertRaises(ValueError):
                self.ledger.dashboard(NOW+3*86400)
        self.assertEqual([dict(r) for r in self.ledger.db.execute('SELECT * FROM events')], expected)
        self.assertFalse(self.ledger.db.in_transaction)

    def test_materialization_serializes_concurrent_observer_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'ledger.sqlite'
            ledger = ledger_module.Ledger(filename)
            try:
                ledger.fleet(fleet(NOW, 10), NOW)
                batch = payload()
                batch['events'].append({**batch['events'][0], 'id': 'quota-second'})
                ledger.ingest(batch, NOW + 600)
                original = ledger.sample
                attempted = []

                def concurrent_sample(*args):
                    if not attempted:
                        observer = sqlite3.connect(filename, timeout=.01)
                        try:
                            with self.assertRaises(sqlite3.OperationalError):
                                observer.execute("INSERT INTO metadata VALUES('concurrent','true')")
                            attempted.append(True)
                        finally:
                            observer.close()
                    return original(*args)

                with patch.object(ledger, 'sample', side_effect=concurrent_sample):
                    ledger.materialize()
                self.assertEqual(attempted, [True])
                self.assertFalse(ledger.db.in_transaction)
                observer = sqlite3.connect(filename, timeout=.01)
                with observer:
                    observer.execute("INSERT INTO metadata VALUES('concurrent','true')")
                observer.close()
                ledger.fleet(fleet(NOW + 600, 14), NOW + 600)
                self.assertEqual(ledger.dashboard(NOW + 700)['schema'], 2)
            finally:
                ledger.db.close()

    def test_collector_rolls_back_failed_cycle_and_publishes_on_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'fleet.json'
            public = Path(directory) / 'public' / 'TEST.json'
            source.write_text(json.dumps(fleet(NOW, 10)))
            original = self.ledger.fleet
            attempts = []

            def transient_failure(data):
                if not attempts:
                    attempts.append(True)
                    self.ledger.meta('uncommitted', True)
                    raise sqlite3.OperationalError('transient database lock')
                self.assertFalse(self.ledger.db.in_transaction)
                self.assertIsNone(self.ledger.setting('uncommitted'))
                original(data)

            output = io.StringIO()
            argv = ['quota_ledger.py', 'serve', '--fleet', str(source), '--output', directory, '--public', str(public)]
            with patch.object(ledger_module, 'Ledger', return_value=self.ledger), \
                    patch.object(self.ledger, 'fleet', side_effect=transient_failure), \
                    patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', output), \
                    patch.object(ledger_module.time, 'sleep', side_effect=[None, StopIteration]):
                with self.assertRaises(StopIteration):
                    ledger_module.main()
            self.assertEqual(json.loads(public.read_text())['schema'], 2)
            self.assertEqual(json.loads(output.getvalue())['type'], 'OperationalError')

    def test_parallel_jobs_partition_instead_of_double_counting(self):
        self.ledger.fleet(fleet(NOW, 10), NOW)
        a = payload()
        a["runs"].append({**a["runs"][0], "run_id": "run-b", "task_id": "task-b@1"})
        a["events"].append({**a["events"][0], "id": "quota-b", "run_id": "run-b"})
        a["events"].append({**a["events"][1], "id": "message-b", "run_id": "run-b", "output_tokens": 300})
        self.ledger.ingest(a, NOW + 600)
        self.ledger.fleet(fleet(NOW + 600, 14), NOW + 600)
        report = self.ledger.report(24, NOW + 700)
        costs = [j["estimated_weekly_pp"] for j in report["jobs"]]
        self.assertAlmostEqual(sum(costs), 4)
        self.assertEqual(costs, [2, 2])  # No invented subscription token pricing.
        self.assertEqual(report["account_deltas"][0]["observed_pp"], 4)
        self.assertTrue(report["quality"]["job_allocations_are_estimates"])

    def test_copied_handoff_stream_and_retries_are_idempotent(self):
        self.ledger.fleet(fleet(NOW, 10), NOW)
        self.ledger.ingest(payload(), NOW + 600)
        copied = payload()
        copied["worker"] = "mac-2"
        self.ledger.ingest(copied, NOW + 600)
        self.ledger.ingest(payload(), NOW + 600)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 2)
        self.assertEqual(self.ledger.db.execute("SELECT SUM(output_tokens) FROM events").fetchone()[0], 100)
        self.ledger.fleet(fleet(NOW + 600, 14), NOW + 600)
        report = self.ledger.report(24, NOW + 700)
        self.assertEqual(len(report["jobs"]), 1)
        self.assertEqual(report["jobs"][0]["estimated_weekly_pp"], 4)

    def test_reset_never_becomes_negative_or_full_week_consumption(self):
        self.ledger.fleet(fleet(NOW, 98), NOW)
        after = fleet(NOW + 600, 2)
        after["machines"][0]["limits"][0]["resetsAt"] = RESET + 604800
        self.ledger.fleet(after, NOW + 600)
        report = self.ledger.report(24, NOW + 700)
        self.assertEqual(sum(r["observed_pp"] for r in report["account_deltas"]), 0)

    def test_unknown_usage_is_not_zero_and_forecast_refuses_small_samples(self):
        p = payload(False)
        p["events"] = []
        self.ledger.ingest(p, NOW + 600)
        report = self.ledger.report(24, NOW + 700)
        self.assertIsNone(report["jobs"][0]["estimated_weekly_pp"])
        self.assertFalse(report["averages"]["kind"])
        self.assertIsNone(self.ledger.forecast(["a@example.com"], {"newsletter": 1})["tasks_per_week"])

    def test_external_consumption_and_large_gaps_stay_separate(self):
        self.ledger.fleet(fleet(NOW, 10), NOW)
        self.ledger.fleet(fleet(NOW + 600, 14), NOW + 600)
        self.ledger.fleet(fleet(NOW + 5000, 20), NOW + 5000)
        row = self.ledger.report(24, NOW + 5100)["account_deltas"][0]
        self.assertEqual(row["unattributed_pp"], 4)
        self.assertEqual(row["gaps"], 1)

    def test_shared_account_and_stale_measurements_are_not_independent_budgets(self):
        self.ledger.fleet(fleet(NOW, 10), NOW)
        self.ledger.fleet(fleet(NOW, 10, worker="mac-2"), NOW)
        self.ledger.fleet(fleet(NOW - 5000, 3), NOW)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0], 1)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM samples").fetchone()[0], 1)

    def test_ambiguous_reset_fingerprint_remains_unassigned(self):
        self.ledger.fleet(fleet(NOW, 10), NOW)
        self.ledger.fleet(fleet(NOW, 10, account="b@example.com", worker="mac-2"), NOW)
        self.assertIsNone(self.ledger.resolve(RESET))

    def test_counter_lag_does_not_count_rebound_twice(self):
        for offset, percent in [(0, 10), (100, 12), (200, 11), (300, 12), (400, 13)]:
            self.ledger.fleet(fleet(NOW + offset, percent), NOW + offset)
        row = self.ledger.report(24, NOW + 500)["account_deltas"][0]
        self.assertEqual(row["observed_pp"], 3)
        self.assertEqual(row["counter_decreases"], 1)

    def test_native_rounding_does_not_hide_later_cli_increment(self):
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(fleet(NOW, 99), NOW)
        batch = payload()
        batch['runs'][0]['pending_scan'] = 0
        batch['events'][0]['windows']['seven_day']['percent'] = 99
        batch['events'].append({**batch['events'][0], 'id': 'quota-finished',
                                'at': NOW + 600,
                                'windows': {'seven_day': {'percent': 100, 'reset': RESET}}})
        self.ledger.fleet(fleet(NOW + 60, 100), NOW + 60)
        self.ledger.ingest(batch, NOW + 600)
        job = self.ledger.report(24, NOW + 700)['jobs'][0]
        self.assertEqual(job['coverage_by_window']['seven_day'], 1)
        self.assertEqual(job['estimated_weekly_pp'], 1)

    def test_flat_counter_across_gap_keeps_pending_rounded_turns(self):
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(fleet(NOW, 10), NOW)
        batch = payload()
        batch['runs'][0]['pending_scan'] = 0
        self.ledger.ingest(batch, NOW + 600)
        self.ledger.fleet(fleet(NOW + 600, 10), NOW + 600)
        self.ledger.fleet(fleet(NOW + 5000, 10), NOW + 5000)
        self.ledger.fleet(fleet(NOW + 5600, 11), NOW + 5600)
        job = self.ledger.report(24, NOW + 5700)['jobs'][0]
        self.assertEqual(job['coverage_by_window']['seven_day'], 1)
        self.assertEqual(job['estimated_weekly_pp'], 1)

    def test_cli_increase_across_gap_is_not_assigned_to_old_turns(self):
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(fleet(NOW, 10), NOW)
        batch = payload()
        batch['events'].append({**batch['events'][0], 'id': 'quota-after-gap',
                                'at': NOW + 5000,
                                'windows': {'seven_day': {'percent': 11, 'reset': RESET}}})
        self.ledger.ingest(batch, NOW + 5000)
        job = self.ledger.report(24, NOW + 5100)['jobs'][0]
        self.assertEqual(job['coverage_by_window']['seven_day'], 0)
        self.assertIsNone(job['estimated_weekly_pp'])

    def test_float_noise_does_not_close_a_rounded_plateau(self):
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(fleet(NOW, 10), NOW)
        self.ledger.ingest(payload(), NOW + 600)
        self.ledger.sample('probe-noise', 'a@example.com', 'mac-1', 'seven_day',
                           RESET, NOW + 600, 10.000000000000002, 'reset_bound_probe', 'probe')
        self.ledger.db.commit()
        job = self.ledger.report(24, NOW + 700)['jobs'][0]
        self.assertEqual(job['coverage_by_window']['seven_day'], 0)
        self.assertIsNone(job['estimated_weekly_pp'])

    def test_jobs_crossing_report_boundary_do_not_train_partial_costs(self):
        self.ledger.fleet(fleet(NOW, 10), NOW)
        p = payload()
        p["runs"][0]["started"] = NOW - 86400
        self.ledger.ingest(p, NOW + 600)
        self.ledger.fleet(fleet(NOW + 600, 14), NOW + 600)
        report = self.ledger.report(24, NOW + 700)
        self.assertTrue(report["jobs"][0]["partial_window"])
        self.assertFalse(report["averages"]["kind"])

    def test_malformed_ingestion_cannot_store_arbitrary_fields(self):
        p = payload()
        p["secret"] = "must-not-be-stored"
        p["events"][0]["prompt"] = "must-not-be-stored"
        self.ledger.ingest(p, NOW + 600)
        self.assertNotIn("must-not-be-stored", "\n".join(self.ledger.db.iterdump()))
        p["worker"] = "../wrong"
        with self.assertRaises(ValueError):
            self.ledger.ingest(p, NOW + 600)

    def test_reset_rejects_historical_replay_and_keeps_a_fixed_start(self):
        self.ledger.ingest(payload(), NOW + 600)
        self.ledger.reset(NOW + 700)
        self.ledger.ingest(payload(), NOW + 800)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM runs').fetchone()[0], 0)
        self.assertEqual(self.ledger.dashboard(NOW + 900)['tracked'], 0)

    def test_small_tasks_wait_for_a_whole_point_and_share_the_closed_plateau(self):
        self.ledger.reset(NOW-1)
        self.ledger.fleet(fleet(NOW,10),NOW)
        a=payload();a['runs'][0]['pending_scan']=0
        self.ledger.ingest(a,NOW+600)
        self.ledger.fleet(fleet(NOW+600,10),NOW+600)
        first=self.ledger.dashboard(NOW+650)
        self.assertIsNone(next(r for r in first['by_kind'] if r['key']=='newsletter')['weekly_pp']['mean'])
        b=payload();b['runs'][0].update(run_id='run-b',task_id='task-b@1',started=NOW+700,finished=NOW+900,pending_scan=0)
        b['events']=[{'id':'message-b','event_type':'message','run_id':'run-b','at':NOW+800,'time_quality':'timestamp'}]
        self.ledger.ingest(b,NOW+900)
        # Same explicit account/reset context from the first job, plus a quota
        # anchor for the second job before the now visible account increase.
        b['events']=[{'id':'quota-b','event_type':'quota','run_id':'run-b','at':NOW+750,'time_quality':'adjacent','windows':{'seven_day':{'percent':10,'reset':RESET}}}]
        self.ledger.ingest(b,NOW+900)
        self.ledger.fleet(fleet(NOW+1000,11),NOW+1000)
        b['events']=[{'id':'quota-b-next','event_type':'quota','run_id':'run-b',
                      'at':NOW+1000,'time_quality':'timestamp',
                      'windows':{'seven_day':{'percent':11,'reset':RESET}}}]
        self.ledger.ingest(b,NOW+1000)
        final=self.ledger.dashboard(NOW+1100)
        row=next(r for r in final['by_kind'] if r['key']=='newsletter')
        self.assertEqual(row['weekly_pp']['n'],2)
        self.assertEqual(row['weekly_pp']['total'],1)
        self.assertEqual(row['weekly_pp']['mean'],.5)

    def test_every_task_is_counted_but_unknown_cost_does_not_become_zero(self):
        self.ledger.reset(NOW - 1)
        p=payload(False);p['events']=[]
        self.ledger.ingest(p,NOW+600)
        summary=self.ledger.dashboard(NOW+700)
        row=next(r for r in summary['by_kind'] if r['key']=='newsletter')
        self.assertEqual(row['tracked'],1)
        self.assertEqual(row['closed'],1)
        self.assertEqual(row['pending'],1)
        self.assertEqual(row['weekly_pp']['n'],0)
        self.assertIsNone(row['weekly_pp']['mean'])

    def test_completion_metadata_refresh_preserves_measured_cost(self):
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(both_windows(NOW, 10), NOW)
        batch = payload()
        batch['runs'][0]['pending_scan'] = 0
        batch['events'][0]['windows']['five_hour'] = {'percent': 10, 'reset': RESET}
        self.ledger.ingest(batch, NOW + 600)
        self.ledger.fleet(both_windows(NOW + 600, 14), NOW + 600)
        self.ledger.dashboard(NOW + 700)
        self.ledger.dashboard(NOW + 2500)
        # The queue confirms completion seconds after the worker. Its next
        # announcement has no events because the stream cursor is already done.
        data = fleet(NOW + 2510, 14)
        data['queue'] = {'tasks': [{'attemptId': 'run-a', 'status': 'completed',
                                  'completedAt': NOW + 610}]}
        self.ledger.fleet(data, NOW + 2510)
        self.ledger.ingest({**batch, 'events': []}, NOW + 2520)
        row = next(r for r in self.ledger.dashboard(NOW + 2600)['by_kind']
                   if r['key'] == 'newsletter')
        self.assertEqual(row['weekly_pp']['n'], 1)
        self.assertEqual(row['weekly_pp']['mean'], 4)
        self.assertEqual(row['pending'], 0)

    def test_finished_parallel_job_stays_in_allocation_denominator(self):
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(both_windows(NOW, 10), NOW)
        first = payload()
        first['runs'][0]['pending_scan'] = 0
        first['events'][0]['windows']['five_hour'] = {'percent': 10, 'reset': RESET}
        self.ledger.ingest(first, NOW + 600)
        second = payload()
        second['runs'][0].update(run_id='run-b', task_id='task-b@1',
                                 state='running', finished=None, pending_scan=0)
        for event in second['events']:
            event.update(id=event['id'] + '-b', run_id='run-b')
        self.ledger.ingest(second, NOW + 600)
        self.ledger.fleet(both_windows(NOW + 600, 14), NOW + 600)
        self.ledger.dashboard(NOW + 700)
        self.ledger.dashboard(NOW + 2500)
        running = next(j for j in self.ledger.report(48, NOW + 2600)['jobs']
                       if j['job'] == 'newsletter:task-b@1')
        self.assertEqual(running['estimated_weekly_pp'], 2)

    def test_compaction_preserves_cumulative_means_and_does_not_reimport_old_runs(self):
        self.ledger.reset(NOW-1)
        self.ledger.fleet(fleet(NOW,10),NOW)
        p=payload();p['runs'][0]['pending_scan']=0
        self.ledger.ingest(p,NOW+600)
        self.ledger.fleet(fleet(NOW+600,14),NOW+600)
        first=self.ledger.dashboard(NOW+700)
        row=next(r for r in first['by_kind'] if r['key']=='newsletter')
        self.assertEqual(row['weekly_pp']['mean'],4)
        self.ledger.dashboard(NOW+3*86400)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM events').fetchone()[0],0)
        self.ledger.ingest(p,NOW+3*86400+100)
        row=next(r for r in self.ledger.dashboard(NOW+3*86400)['by_kind'] if r['key']=='newsletter')
        self.assertEqual(row['weekly_pp']['mean'],4)
        self.assertEqual(row['weekly_pp']['n'],1)

    def test_sales_metadata_uses_exact_queue_identity_without_assuming_completion(self):
        data = fleet(NOW, 10)
        data["queue"] = {"tasks": [{"id": "sales:123.456", "workflow": "sales", "url": "https://shop.example/a",
            "title": "Sales · shop.example", "status": "completed", "completedAt": NOW + 600}]}
        self.ledger.fleet(data, NOW)
        p = payload(False)
        p["runs"][0].update(task_id="sales:123.456", customer="", kind="sales", state="unverified", finished=None)
        self.ledger.ingest(p, NOW + 600)
        row = self.ledger.db.execute("SELECT customer,state,finished FROM runs").fetchone()
        self.assertEqual(tuple(row), ("shop.example", "completed", NOW + 600))

    def test_worker_run_keeps_its_own_end_and_state_over_a_later_queue_completion(self):
        # Fehleraudit 26.10.2026: the order completed 9 h after the run ended, and a
        # blocked upload run must never become 'completed' through its order.
        data = fleet(NOW, 10)
        data["queue"] = {"tasks": [{"id": "clickup:upload:a", "workflow": "upload", "attemptId": "run-a",
                                    "status": "completed", "completedAt": NOW + 600 + 9 * 3600}]}
        self.ledger.fleet(data, NOW)
        p = payload(False)
        p["runs"][0].update(state="blockiert")
        self.ledger.ingest(p, NOW + 700)
        self.assertEqual(tuple(self.ledger.db.execute("SELECT state,finished FROM runs").fetchone()), ("blockiert", NOW + 600))
        # A run without its own end still takes the queue's completion.
        p["runs"][0].update(finished=None, state="running")
        self.ledger.db.execute("DELETE FROM runs")
        self.ledger.ingest(p, NOW + 700)
        self.assertEqual(tuple(self.ledger.db.execute("SELECT state,finished FROM runs").fetchone()),
                         ("completed", NOW + 600 + 9 * 3600))

    def test_queue_end_already_recorded_is_corrected_by_the_next_worker_report(self):
        data = fleet(NOW, 10)
        data["queue"] = {"tasks": [{"attemptId": "run-a", "status": "completed", "completedAt": NOW + 30000}]}
        self.ledger.fleet(data, NOW)
        self.ledger.db.execute("INSERT INTO runs(worker,run_id,job,task_id,kind,started,finished,state,last_seen) VALUES(?,?,?,?,?,?,?,?,?)",
                               ("mac-1", "run-a", "newsletter:task-a@1", "task-a@1", "newsletter", NOW, NOW + 30000, "completed", NOW))
        self.ledger.ingest(payload(False), NOW + 700)
        self.assertEqual(tuple(self.ledger.db.execute("SELECT state,finished FROM runs").fetchone()), ("fertig", NOW + 600))

    def test_language_version_moves_with_its_turns_from_newsletter_to_translation(self):
        self.ledger.reset(NOW - 1)
        first = payload()
        first["runs"].append({**first["runs"][0], "run_id": "run-other", "task_id": "task-b@1"})
        self.ledger.ingest(first, NOW + 600)
        self.ledger.db.execute("INSERT INTO compact_jobs VALUES('newsletter:task-a@1',?,?)", (NOW + 600, b"x"))
        self.ledger.db.execute("INSERT INTO tool_usage(id,job,name) VALUES('tool-a','newsletter:task-a@1','Read')")
        again = payload(False)
        again["runs"][0]["kind"] = "translation"
        self.ledger.ingest(again, NOW + 700)
        db = self.ledger.db
        self.assertEqual(tuple(db.execute("SELECT job,kind FROM runs WHERE run_id='run-a'").fetchone()),
                         ("translation:task-a@1", "translation"))
        self.assertEqual({r[0] for r in db.execute("SELECT job FROM events WHERE run_id='run-a'")}, {"translation:task-a@1"})
        self.assertEqual(db.execute("SELECT job FROM tool_usage").fetchone()[0], "translation:task-a@1")
        self.assertIsNone(db.execute("SELECT 1 FROM compact_jobs WHERE job='newsletter:task-a@1'").fetchone())
        # Other newsletter runs keep their kind; a later report never turns it back.
        self.assertEqual(db.execute("SELECT kind FROM runs WHERE run_id='run-other'").fetchone()[0], "newsletter")
        self.ledger.ingest(payload(False), NOW + 800)
        self.assertEqual(db.execute("SELECT kind FROM runs WHERE run_id='run-a'").fetchone()[0], "translation")

    def test_language_version_compacted_as_newsletter_is_not_reimported_twice(self):
        self.ledger.reset(NOW - 1)
        self.ledger.db.execute("INSERT INTO compact_jobs VALUES('newsletter:task-a@1',?,?)", (NOW + 600, b"x"))
        again = payload(False)
        again["runs"][0]["kind"] = "translation"
        self.ledger.ingest(again, NOW + 3 * 86400)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 0)

    def sales_phase(self, task, worker="mac-1", run=None, started=NOW, state="running", last=None):
        run = run or task.replace(":", "-") + "-abcd"
        self.ledger.db.execute("INSERT INTO runs(worker,run_id,job,task_id,kind,started,state,last_seen) VALUES(?,?,?,?,?,?,?,?)",
                               (worker, run, "sales:" + task, task, "sales", started, state, NOW))
        if last is not None:
            self.ledger.db.execute("INSERT INTO events(id,event_type,job,worker,run_id,at) VALUES(?,?,?,?,?,?)",
                                   ("m-" + run, "message", "sales:" + task, worker, run, last))
        return run

    def test_sales_phases_close_with_blocked_aborted_or_elsewhere_completed_hub_jobs(self):
        # Fehleraudit 26.10.2026: 16 ended Sales builds stayed 'running' for days.
        blocked = self.sales_phase("sales:1.1", last=NOW + 900)
        aborted = self.sales_phase("sales:2.2", last=NOW + 1200)
        elsewhere = self.sales_phase("sales:3.3", worker="gelb", last=NOW + 600)
        undated = self.sales_phase("sales:4.4", started=None, state="unverified")
        live = self.sales_phase("sales:5.5", last=NOW + 3000)
        fresh = self.sales_phase("sales:6.6", last=NOW + 3000)
        late = self.sales_phase("sales:7.7", started=NOW + 1200, last=NOW + 1500)
        data = fleet(NOW + 3600, 10)
        data["queue"] = {"tasks": [
            {"id": "sales:1.1", "workflow": "sales", "status": "blocked", "workerId": "mac-1"},
            {"id": "sales:3.3", "workflow": "sales", "status": "completed", "workerId": "pink", "completedAt": NOW + 3000},
            {"id": "sales:4.4", "workflow": "sales", "status": "completed", "workerId": "mac-1"},
            {"id": "sales:5.5", "workflow": "sales", "status": "running", "workerId": "mac-1"},
            {"id": "sales:7.7", "workflow": "sales", "status": "completed", "completedAt": NOW + 1000}]}
        self.ledger.fleet(data, NOW + 3600)
        rows = {r["run_id"]: (r["state"], r["finished"]) for r in self.ledger.db.execute("SELECT run_id,state,finished FROM runs")}
        self.assertEqual(rows[blocked], ("blockiert", NOW + 900))
        self.assertEqual(rows[aborted], ("abgebrochen", NOW + 1200))
        self.assertEqual(rows[elsewhere], ("completed", NOW + 3000))
        self.assertEqual(rows[undated], ("completed", None))
        self.assertEqual(rows[live], ("running", None))
        # Not listed yet and active within 30 minutes: may be a just reserved job.
        self.assertEqual(rows[fresh], ("running", None))
        # Started after the job's completion: closed only once silent.
        self.assertEqual(rows[late], ("completed", NOW + 1500))
        # An unverified report of the gone receipt keeps the closed state.
        p = payload(False)
        p["runs"][0].update(run_id=aborted, task_id="sales:2.2", kind="sales", state="unverified", finished=None)
        self.ledger.ingest(p, NOW + 3700)
        self.assertEqual(self.ledger.db.execute("SELECT state FROM runs WHERE run_id=?", (aborted,)).fetchone()[0], "abgebrochen")

    def test_sales_phases_stay_open_without_a_sales_listing(self):
        run = self.sales_phase("sales:2.2", last=NOW)
        self.ledger.fleet(fleet(NOW + 7200, 10), NOW + 7200)
        self.assertEqual(self.ledger.db.execute("SELECT state FROM runs WHERE run_id=?", (run,)).fetchone()[0], "running")


    def test_scheduler_preserves_measurement_age_and_shares_one_account_budget(self):
        self.ledger.fleet(fleet(NOW, 23, worker='mac-a'), NOW)
        shared = fleet(NOW, 23)
        shared['machines'][0]['workerId'] = 'mac-b'
        self.ledger.fleet(shared, NOW)
        account = self.ledger.db.execute('SELECT account FROM accounts').fetchone()[0]
        groups = [{'key': account+'|newsletter', 'weekly_pp': {'n': 3, 'mean': 4, 'sd': 1},
                   'five_hour_pp': {'n': 0, 'mean': None, 'sd': 0}}]
        s = self.ledger.scheduling(groups, NOW + 1000)['workers']
        self.assertEqual(s['mac-a']['account'], s['mac-b']['account'])
        self.assertEqual(s['mac-a']['windows']['seven_day']['at'], NOW)
        self.assertEqual(s['mac-b']['costs']['newsletter']['weekly_pp']['mean'], 4)
        self.assertIsNone(s['mac-a']['costs']['newsletter']['five_hour_pp']['mean'])

    def test_scheduler_uses_only_exact_unambiguous_device_links(self):
        data = fleet(NOW, 20)
        data['machines'][0].update(workerId=None, deviceId='device-a')
        data['workerLinks'] = [{'deviceId': 'device-a', 'workerId': 'mac-linked'}]
        self.ledger.fleet(data, NOW)
        self.assertIn('mac-linked', self.ledger.scheduling([], NOW)['workers'])
        data['workerLinks'].append({'deviceId': 'device-a', 'workerId': 'mac-other'})
        fresh = ledger_module.Ledger(':memory:');fresh.fleet(data, NOW)
        self.assertEqual(fresh.scheduling([], NOW)['workers'], {})

    def test_worker_pool_selected_budget_overrides_native_limit_without_rebinding_identity_or_prices(self):
        self.ledger.fleet(pool_fleet(), NOW)
        native = 'a@example.com'
        groups = [{'key': native+'|newsletter', 'weekly_pp': {'n': 3, 'mean': 4, 'sd': 1}}]
        q = self.ledger.scheduling(groups, NOW)['workers']['mac-1']
        self.assertEqual((q['source'], q['scope'], q['evidence_status']), ('worker_pool', 'worker_slot', 'fresh'))
        self.assertEqual(q['windows']['seven_day'], {'used': 24, 'reset': RESET + 3600, 'at': NOW})
        self.assertEqual(q['windows']['five_hour']['used'], 12)
        self.assertEqual(q['costs'], {})
        self.assertNotEqual(q['account'], ledger_module.identifier(native)[:24])
        self.assertEqual(self.ledger.db.execute('SELECT account FROM bindings WHERE until IS NULL').fetchone()[0], native)
        self.assertEqual([tuple(r) for r in self.ledger.db.execute('SELECT account,percent FROM samples')], [(native, 100)])
        exported = json.dumps(q)
        self.assertNotIn(native, exported)
        self.assertNotIn('Claude 2', exported)

    def test_pool_switch_replaces_windows_immediately_and_invalidates_only_changed_scheduling(self):
        data = pool_fleet(selected='primary')
        self.ledger.fleet(data, NOW)
        before = self.ledger.scheduling([], NOW)['workers']['mac-1']
        self.assertEqual(before['windows']['seven_day']['used'], 100)
        revision = self.ledger.setting('average_pending')['revision']
        report = data['workerReports'][0]
        report.update(sampledAt=ledger_module.iso(NOW + 10), receivedAt=ledger_module.iso(NOW + 10))
        self.ledger.fleet(data, NOW + 10)
        self.assertEqual(self.ledger.setting('average_pending')['revision'], revision, 'observer heartbeat does not recompute averages')
        report['claudeAccounts']['selectedAccountId'] = 'account-2'
        self.ledger.fleet(data, NOW + 10)
        q = self.ledger.scheduling([], NOW + 10)['workers']['mac-1']
        self.assertNotEqual(q['account'], before['account'])
        self.assertEqual(q['windows']['seven_day']['used'], 24)
        self.assertEqual(q['windows']['seven_day']['at'], NOW, 'selection never refreshes the measurement time')
        self.assertGreater(self.ledger.setting('average_pending')['revision'], revision)

    def test_silent_unknown_or_reset_pool_never_falls_back_to_native_100_percent(self):
        data = pool_fleet()
        self.ledger.fleet(data, NOW)
        revision = self.ledger.setting('average_pending')['revision']
        self.ledger.fleet(data, NOW + 46)
        q = self.ledger.scheduling([], NOW + 46)['workers']['mac-1']
        self.assertEqual((q['evidence_status'], q['status'], q['windows']), ('unknown', 'unknown', {}))
        self.assertGreater(self.ledger.setting('average_pending')['revision'], revision, 'staleness publishes on the next collector pass')
        data.pop('workerReports')
        self.ledger.fleet(data, NOW + 47)
        self.assertEqual(self.ledger.scheduling([], NOW + 47)['workers']['mac-1']['windows'], {})
        for change in ('stale_sample', 'future_sample', 'reset_passed', 'error'):
            with self.subTest(change=change):
                data = pool_fleet()
                chosen = data['workerReports'][0]['claudeAccounts']['accounts'][1]
                if change == 'stale_sample':
                    chosen['updatedAt'] = ledger_module.iso(NOW - 601)
                elif change == 'future_sample':
                    chosen['updatedAt'] = ledger_module.iso(NOW + 31)
                elif change == 'reset_passed':
                    chosen['windows'][0]['reset'] = ledger_module.iso(NOW)
                else:
                    chosen['status'] = 'error'
                self.ledger.fleet(data, NOW)
                self.assertEqual(self.ledger.scheduling([], NOW)['workers']['mac-1']['windows'], {})

    def test_pool_requires_exact_device_link_and_never_deduplicates_slots_across_macs(self):
        data = pool_fleet()
        data['workerReports'][0]['deviceId'] = 'another-device'
        self.ledger.fleet(data, NOW)
        self.assertNotIn('source', self.ledger.scheduling([], NOW)['workers']['mac-1'])
        data = pool_fleet()
        data['machines'][0]['workerId'] = None
        data['workerLinks'] = [{'workerId': 'mac-1', 'deviceId': 'device-a'}]
        self.ledger.fleet(data, NOW)
        first = self.ledger.scheduling([], NOW)['workers']['mac-1']
        self.assertEqual(first['source'], 'worker_pool')
        self.ledger.fleet(pool_fleet(worker='mac-2', device='device-b'), NOW)
        other = self.ledger.scheduling([], NOW)['workers']['mac-2']
        self.assertNotEqual(first['account'], other['account'], 'a matching slot/name is no proof of shared provider identity')

    def test_partial_pool_usage_is_not_invented_and_malformed_pool_is_unknown(self):
        data = pool_fleet()
        chosen = data['workerReports'][0]['claudeAccounts']['accounts'][1]
        chosen['windows'] = [{'kind': 'session', 'percent': 0, 'reset': None}]
        self.ledger.fleet(data, NOW)
        q = self.ledger.scheduling([], NOW)['workers']['mac-1']
        self.assertEqual(q['windows'], {'five_hour': {'used': 0, 'reset': None, 'at': NOW}})
        chosen['windows'].append({'kind': 'weekly', 'percent': True, 'reset': ledger_module.iso(RESET)})
        self.ledger.fleet(data, NOW)
        self.assertEqual(self.ledger.scheduling([], NOW)['workers']['mac-1']['windows'], {})
        data['workerReports'][0]['claudeAccounts']['accounts'][0]['id'] = []
        self.ledger.fleet(data, NOW)
        self.assertEqual(self.ledger.scheduling([], NOW)['workers']['mac-1']['windows'], {})

    def test_existing_cli_probe_refreshes_only_its_proven_account_and_keeps_real_sample_time(self):
        self.ledger.fleet(fleet(NOW, 20), NOW)
        p = {'schema': 1, 'worker': 'mac-1', 'probe': {'at': NOW+500,
             'windows': {'seven_day': {'percent': 24, 'reset': RESET},
                         'five_hour': {'percent': 12, 'reset': NOW+3600}}}}
        self.ledger.ingest(p, NOW+501)
        q = self.ledger.scheduling([], NOW+700)['workers']['mac-1']
        self.assertEqual(q['windows']['seven_day']['used'], 24)
        self.assertEqual(q['windows']['five_hour']['at'], NOW+500)
        p['worker'] = 'another-mac'
        self.ledger.ingest(p, NOW+502)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM samples WHERE source='probe'").fetchone()[0], 2)

        p['worker'] = 'mac-1';p['probe']['windows']['seven_day']['reset'] = RESET+1234
        self.ledger.ingest(p, NOW+503)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM samples WHERE source='probe'").fetchone()[0], 2)

    def test_stale_native_identity_can_bind_new_cli_evidence_without_refreshing_old_usage(self):
        self.ledger.fleet(fleet(NOW-1800, 20), NOW)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM samples').fetchone()[0], 0)
        self.ledger.ingest({'schema': 1, 'worker': 'mac-1', 'probe': {'at': NOW,
                           'windows': {'seven_day': {'percent': 30, 'reset': RESET}}}}, NOW)
        q = self.ledger.scheduling([], NOW)['workers']['mac-1']
        self.assertEqual(q['windows']['seven_day'], {'used': 30, 'reset': RESET, 'at': NOW})

    def stream_samples(self):
        return sorted(tuple(r) for r in self.ledger.db.execute(
            "SELECT account,worker,window,percent FROM samples WHERE source='stream'"))

    def test_colliding_weekly_reset_of_another_macs_pool_slot_never_overwrites_a_bound_account(self):
        """21.10.2026: Lila's account-2 stream was exported as Schwarz's quota."""
        schwarz, lila = NOW + 3600, NOW + 7200
        for registered in (True, False):
            with self.subTest(pool_report=registered):
                self.ledger = ledger_module.Ledger(':memory:')
                data = {'machines': [bound_machine('mac-s', 'aurelian@rss.example', schwarz, five=100),
                                     bound_machine('mac-l', 'lila@rss.example', lila, weekly_reset=RESET + 3600, device='device-l')],
                        'workerReports': [pool_report('mac-l', 'device-l', lila)] if registered else []}
                self.ledger.fleet(data, NOW)
                self.ledger.ingest(stream('mac-l', lila, 'run-l'), NOW + 120)
                self.ledger.ingest(stream('mac-s', schwarz, 'run-s', five=100), NOW + 120)
                self.ledger.materialize()
                self.assertEqual(self.stream_samples(), [('aurelian@rss.example', 'mac-s', 'five_hour', 100),
                                                         ('aurelian@rss.example', 'mac-s', 'seven_day', 30)])
                q = self.ledger.scheduling([], NOW + 120)['workers']['mac-s']
                self.assertEqual(q['windows']['five_hour']['used'], 100)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM pool_resets').fetchone()[0], 0)

    def test_pool_slot_fingerprints_make_an_unconfirmed_collision_ambiguous(self):
        lila = NOW + 7200
        data = {'machines': [bound_machine('mac-s', 'aurelian@rss.example', NOW + 3600),
                             bound_machine('mac-l', 'lila@rss.example', lila, weekly_reset=RESET + 3600, device='device-l')],
                'workerReports': [pool_report('mac-l', 'device-l', lila)]}
        self.ledger.fleet(data, NOW)
        rows = {tuple(r) for r in self.ledger.db.execute('SELECT window,reset,worker FROM pool_resets')}
        self.assertEqual(rows, {('five_hour', lila, 'mac-l'), ('seven_day', RESET, 'mac-l'), ('seven_day', RESET + 7200, 'mac-l')})
        # Weekly reset alone: Schwarz's account and Lila's slot both match.
        self.assertIsNone(self.ledger.resolve(RESET, None, 'mac-s', NOW + 60))
        self.assertEqual(self.ledger.resolve(RESET, NOW + 3600, 'mac-s', NOW + 60), 'aurelian@rss.example')
        self.assertIsNone(self.ledger.resolve(RESET, lila, 'mac-l', NOW + 60), 'a pool slot is never an account')
        self.assertIsNone(self.ledger.resolve(RESET + 7200, None, 'mac-l', NOW + 60))

    def test_same_weekly_reset_with_different_5h_resets_on_different_workers_never_merges(self):
        first, second = NOW + 3600, NOW + 7200
        self.ledger.fleet({'machines': [bound_machine('mac-1', 'a@example.com', first, five=20),
                                        bound_machine('mac-2', 'b@example.com', second, five=70)]}, NOW)
        self.ledger.ingest(stream('mac-1', first, 'run-1', five=21), NOW + 120)
        self.ledger.ingest(stream('mac-2', second, 'run-2', five=71), NOW + 120)
        self.ledger.ingest(stream('mac-2', None, 'run-3', at=NOW + 90), NOW + 120)
        self.ledger.materialize()
        self.assertEqual(self.stream_samples(), [('a@example.com', 'mac-1', 'five_hour', 21), ('a@example.com', 'mac-1', 'seven_day', 30),
                                                 ('b@example.com', 'mac-2', 'five_hour', 71), ('b@example.com', 'mac-2', 'seven_day', 30)])
        workers = self.ledger.scheduling([], NOW + 120)['workers']
        self.assertEqual((workers['mac-1']['windows']['five_hour']['used'], workers['mac-2']['windows']['five_hour']['used']), (21, 71))
        # An unbound worker is accepted only with the 5h reset as cross-confirmation.
        self.assertIsNone(self.ledger.resolve(RESET, NOW + 9000, 'mac-9', NOW + 60))
        self.assertEqual(self.ledger.resolve(RESET, second, 'mac-9', NOW + 60), 'b@example.com')
        self.assertIsNone(self.ledger.resolve(RESET, second, 'mac-1', NOW - 5 * 3600),
                          'without a covering window both accounts stay candidates')

    def test_fresh_report_without_pool_forgets_it_but_a_silent_observer_keeps_it(self):
        data = pool_fleet()
        self.ledger.fleet(data, NOW)
        self.assertEqual(self.ledger.scheduling([], NOW)['workers']['mac-1']['source'], 'worker_pool')
        report = data['workerReports'][0]
        report.pop('claudeAccounts')
        report.update(sampledAt=ledger_module.iso(NOW - 50), receivedAt=ledger_module.iso(NOW - 50))
        self.ledger.fleet(data, NOW)
        self.assertEqual(self.ledger.scheduling([], NOW)['workers']['mac-1']['source'], 'worker_pool', 'an old report is no proof')
        revision = self.ledger.setting('average_pending')['revision']
        report.update(sampledAt=ledger_module.iso(NOW + 10), receivedAt=ledger_module.iso(NOW + 10))
        self.ledger.fleet(data, NOW + 10)
        q = self.ledger.scheduling([], NOW + 10)['workers']['mac-1']
        self.assertNotIn('source', q)
        self.assertEqual(q['account'], ledger_module.identifier('a@example.com')[:24])
        self.assertEqual(self.ledger.setting('worker_pool_scheduling'), {})
        self.assertGreater(self.ledger.setting('average_pending')['revision'], revision, 'losing the last pool republishes')

    def test_workers_absent_for_a_day_lose_pool_and_binding_and_are_no_longer_exported(self):
        data = pool_fleet()
        data['machines'][0]['lastSeenAt'] = ledger_module.iso(NOW)
        data['machines'].append(bound_machine('mac-2', 'b@example.com', NOW + 7200))
        self.ledger.fleet(data, NOW)
        self.assertEqual(sorted(self.ledger.scheduling([], NOW)['workers']), ['mac-1', 'mac-2'])
        later = NOW + 86400 + 60
        data['workerReports'] = []
        data['machines'][1] = bound_machine('mac-2', 'b@example.com', later + 3600, at=later)
        self.ledger.fleet(data, later)
        self.ledger.fleet(data, later + 15)
        self.assertEqual(sorted(self.ledger.scheduling([], later + 15)['workers']), ['mac-2'])
        self.assertEqual(self.ledger.setting('worker_pool_scheduling'), {})
        self.assertEqual([tuple(r) for r in self.ledger.db.execute('SELECT worker,until FROM bindings ORDER BY worker')],
                         [('mac-1', later), ('mac-2', None)], 'the stale row never reopens its binding')
        self.assertNotIn('mac-1', self.ledger.setting('worker_seen'))
        # The same Mac back in Fleet starts a new binding.
        data['machines'][0]['lastSeenAt'] = ledger_module.iso(later + 30)
        self.ledger.fleet(data, later + 30)
        self.assertEqual(sorted(self.ledger.scheduling([], later + 30)['workers']), ['mac-1', 'mac-2'])
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM bindings WHERE worker=? AND until IS NULL', ('mac-1',)).fetchone()[0], 1)

    def test_a_hub_heartbeat_keeps_a_worker_live_and_legacy_memory_expires_by_its_own_age(self):
        data = fleet(NOW, 20)
        data['machines'][0]['lastSeenAt'] = ledger_module.iso(NOW - 3 * 86400)
        data['observedWorkers'] = [{'workerId': 'mac-1', 'lastSeenAt': ledger_module.iso(NOW - 600)}]
        self.ledger.fleet(data, NOW)
        self.assertIn('mac-1', self.ledger.scheduling([], NOW)['workers'])
        # Pool memory written before the liveness bookkeeping existed.
        retired = ledger_module.pool_observation(pool_fleet(NOW - 2 * 86400, worker='retired', device='old')['workerReports'][0],
                                                 'retired', 'old')
        self.ledger.meta('worker_pool_scheduling', {'retired': retired})
        self.ledger.fleet(data, NOW + 15)
        self.assertEqual(self.ledger.setting('worker_pool_scheduling'), {})
        self.assertNotIn('retired', self.ledger.scheduling([], NOW + 15)['workers'])

class WorkerTests(unittest.TestCase):
    def test_finished_sales_recovers_session_and_subagents_without_active_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            root = home / 'runs/sales-123.456-abcd'
            root.mkdir(parents=True)
            session = '12345678-1234-1234-1234-123456789abc'
            (root / 'stream.jsonl').write_text('\n'.join(json.dumps(e) for e in [
                {'type': 'system', 'subtype': 'init', 'session_id': session},
                {'type': 'assistant', 'timestamp': ledger_module.iso(NOW)}]) + '\n')
            sub = home / '.claude/projects/exact-project' / session / 'subagents/agent-a.jsonl'
            sub.parent.mkdir(parents=True)
            sub.write_text('')
            unrelated = home / '.claude/projects/exact-project/other/subagents/agent-b.jsonl'
            unrelated.parent.mkdir(parents=True)
            unrelated.write_text('')
            state = home / 'worker.sqlite'
            with sqlite3.connect(state) as db:
                db.execute('CREATE TABLE runs(run_id,task_id,task_name,run_dir,state,started_at,finished_at,queued_at)')
            with patch.object(worker_module.Path, 'home', return_value=home):
                rows = worker_module.run_inventory({'paths': {'state_db': str(state), 'runs_dir': str(home / 'runs')}}, 120, NOW + 100)
            self.assertEqual(len(rows), 2)
            self.assertEqual({r['task_id'] for r in rows}, {'sales:123.456'})
            self.assertEqual({r['session'] for r in rows}, {session})
            self.assertEqual({r['started'] for r in rows}, {ledger_module.iso(NOW)})
            self.assertEqual({r['state'] for r in rows}, {'unverified'})

    def test_inventory_includes_phase_and_subagent_streams_in_the_same_logical_task(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);root=home/'runs'/'run-a';root.mkdir(parents=True)
            for stream in [root/'stream.jsonl',root/'kundenablage'/'ablage'/'stream.jsonl']:
                stream.parent.mkdir(parents=True,exist_ok=True);stream.write_text('')
            session='12345678-1234-1234-1234-123456789abc'
            sub=home/'.claude/projects/project'/session/'subagents/agent-a.jsonl';sub.parent.mkdir(parents=True);sub.write_text('')
            state=home/'worker.sqlite'
            with sqlite3.connect(state) as db:
                db.execute('CREATE TABLE runs(run_id,task_id,task_name,run_dir,state,started_at,finished_at,queued_at,session_id,customer_name)')
                db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)',('run-a','task-a','Title',str(root),'running',ledger_module.iso(NOW),None,ledger_module.iso(NOW),session,'Customer'))
            with patch.object(worker_module.Path,'home',return_value=home):
                rows=worker_module.run_inventory({'paths':{'state_db':str(state),'runs_dir':str(home/'runs')}},72,NOW+500)
            self.assertEqual(len(rows),3)
            self.assertEqual({r['task_id'] for r in rows},{'task-a'})

    def test_tracking_epoch_rewinds_cursors_once_without_exporting_earlier_events(self):
        with tempfile.TemporaryDirectory() as directory:
            stream=Path(directory)/'stream.jsonl'
            stream.write_text(''.join(json.dumps({'type':'assistant','timestamp':ledger_module.iso(at),'message':{'id':str(at),'usage':{'output_tokens':10}}})+'\n' for at in [NOW-100,NOW+100]))
            inventory=[{'run_id':'r','task_id':'t','stream':str(stream)}]
            sent=[]
            def sender(config,body):
                sent.extend(body['events']);return {'ok':True,'tracking_since':NOW}
            with patch.object(worker_module,'run_inventory',return_value=inventory):
                worker_module.collect({'worker':'mac-1'},Path(directory)/'cursors.sqlite',sender=sender,now=NOW+200)
                worker_module.collect({'worker':'mac-1'},Path(directory)/'cursors.sqlite',sender=sender,now=NOW+300)
            self.assertEqual([e['at'] for e in sent],[NOW+100])

    def test_stream_omits_content_deduplicates_usage_and_marks_quota_time(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Path(directory) / "stream.jsonl"
            msg = {"type": "assistant", "timestamp": "2026-10-18T19:00:00Z", "message": {
                "id": "msg", "model": "model", "content": "secret", "usage": {"output_tokens": 10}}}
            quota = {"type": "rate_limit_event", "uuid": "q", "rate_limit_info": {"unifiedWindows": {
                "seven_day": {"utilization": .42, "resetsAt": RESET}}}}
            f.write_text("\n".join(json.dumps(e) for e in [msg, {**msg, "message": {**msg["message"], "usage": {"output_tokens": 20}}}, quota]) + "\n")
            events, offset, at, skipped = worker_module.read_chunk(f)
            self.assertEqual(len([e for e in events if e['event_type'] != 'evidence']), 2)
            self.assertNotIn("secret", json.dumps(events))
            self.assertEqual(next(e for e in events if e["event_type"] == "message")["output_tokens"], 20)
            self.assertEqual(events[0]["time_quality"], "adjacent")
            self.assertEqual(events[0]["windows"]["seven_day"]["percent"], 42)
            self.assertEqual(offset, f.stat().st_size)

    def test_partial_line_is_retried_after_append(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Path(directory) / "stream.jsonl"
            raw = json.dumps({"type": "assistant", "timestamp": "2026-10-18T19:00:00Z", "message": {
                "id": "msg", "usage": {"output_tokens": 10}}})
            f.write_text(raw[:20])
            events, offset, at, _ = worker_module.read_chunk(f)
            self.assertEqual(offset, 0)
            self.assertEqual(events, [])
            f.write_text(raw + "\n")
            self.assertEqual(len([e for e in worker_module.read_chunk(f, offset, at)[0] if e['event_type'] != 'evidence']), 1)

    def test_workflow_includes_corrections_upload_and_sales(self):
        for task, kind in [("korrektur-cu-123", "correction"), ("a-klaviyo", "upload"),
                           ("a-translation-en", "translation"), ("sales:123.45", "sales")]:
            self.assertEqual(worker_module.workflow(task), kind)

    def test_language_version_task_is_a_translation_like_the_worker_run_kind(self):
        # Fehleraudit 26.10.2026: "FR | …" tasks have plain ClickUp IDs; only runs.fassung names them.
        task, path = "12451cu94ev@1793007523112", "/runs/20261026T122226Z-4bb7-12451cu94ev@1793007523112"
        self.assertEqual(worker_module.workflow(task, path, json.dumps({"sprache": "FR", "de_task_id": "x"})), "translation")
        self.assertEqual(worker_module.workflow(task, path, json.dumps({"sprache": "EN", "bestandsflow": {
            "schema": "rs-existing-flow-source/v1"}})), "newsletter")
        for value in (None, "", "{", json.dumps({"de_task_id": "x"})):
            self.assertEqual(worker_module.workflow(task, path, value), "newsletter")
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / "worker.sqlite"
            with sqlite3.connect(state) as db:
                db.execute("CREATE TABLE runs(run_id,task_id,task_name,run_dir,state,started_at,finished_at,queued_at,fassung)")
                for run, fassung in (("run-fr", json.dumps({"sprache": "FR"})), ("run-de", None)):
                    db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)", (run, task, "FR | Golfbag", str(home / run), "fertig",
                               ledger_module.iso(NOW), ledger_module.iso(NOW + 60), ledger_module.iso(NOW), fassung))
            with patch.object(worker_module.Path, "home", return_value=home):
                rows = worker_module.run_inventory({"paths": {"state_db": str(state), "runs_dir": str(home / "runs")}}, 72, NOW + 100)
            self.assertEqual({r["run_id"]: r["kind"] for r in rows}, {"run-fr": "translation", "run-de": "newsletter"})

    def test_failed_acknowledgement_preserves_cursor_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            stream = Path(directory) / "stream.jsonl"
            stream.write_text(json.dumps({"type": "assistant", "timestamp": "2026-10-18T19:00:00Z",
                "message": {"id": "msg", "usage": {"output_tokens": 10}}}) + "\n")
            inventory = [{"run_id": "r", "task_id": "t", "stream": str(stream)}]
            cache = Path(directory) / "cursor.sqlite"
            calls = []
            def fail(config, body):
                calls.append(body)
                if body["events"]:
                    raise ValueError("failed acknowledgement")
            with patch.object(worker_module, "run_inventory", return_value=inventory):
                with self.assertRaises(ValueError):
                    worker_module.collect({"worker": "mac-1"}, cache, sender=fail)
                import sqlite3
                with sqlite3.connect(cache) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM cursors").fetchone()[0], 0)
                worker_module.collect({"worker": "mac-1"}, cache, sender=lambda c, body: calls.append(body))
            self.assertEqual(sum(len(body["events"]) for body in calls), 2)


if __name__ == "__main__":
    unittest.main()
