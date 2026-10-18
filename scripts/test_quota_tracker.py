import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
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


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.ledger = ledger_module.Ledger(":memory:")

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
        self.assertGreater(max(costs), min(costs))
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


class WorkerTests(unittest.TestCase):
    def test_stream_omits_content_deduplicates_usage_and_marks_quota_time(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Path(directory) / "stream.jsonl"
            msg = {"type": "assistant", "timestamp": "2026-10-18T19:00:00Z", "message": {
                "id": "msg", "model": "model", "content": "secret", "usage": {"output_tokens": 10}}}
            quota = {"type": "rate_limit_event", "uuid": "q", "rate_limit_info": {"unifiedWindows": {
                "seven_day": {"utilization": .42, "resetsAt": RESET}}}}
            f.write_text("\n".join(json.dumps(e) for e in [msg, {**msg, "message": {**msg["message"], "usage": {"output_tokens": 20}}}, quota]) + "\n")
            events, offset, at, skipped = worker_module.read_chunk(f)
            self.assertEqual(len(events), 2)
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
            self.assertEqual(len(worker_module.read_chunk(f, offset, at)[0]), 1)

    def test_workflow_includes_corrections_upload_and_sales(self):
        for task, kind in [("korrektur-cu-123", "correction"), ("a-klaviyo", "upload"),
                           ("a-translation-en", "translation"), ("sales:123.45", "sales")]:
            self.assertEqual(worker_module.workflow(task), kind)

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
