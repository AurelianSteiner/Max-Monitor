import fcntl
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib

from quota_ledger import AVERAGE_SNAPSHOT_SECONDS, Ledger, stamp
from test_quota_tracker import NOW, both_windows, payload


class AverageUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.path = self.root / 'ledger.sqlite'
        self.public = self.root / 'public' / 'TEST.json'
        self.ledger = Ledger(self.path)
        self.ledger.reset(NOW - 1)
        self.ledger.fleet(both_windows(NOW, 10), NOW)
        self.ledger.ingest(payload(), NOW + 650)
        self.ledger.fleet(both_windows(NOW + 700, 12), NOW + 700)
        self.ledger.materialize()
        self.at = NOW + 701

    def tearDown(self):
        self.ledger.db.close()
        self.folder.cleanup()

    def new_task(self, name='new', at=None):
        at = self.at + 5 if at is None else at
        return {'schema': 1, 'worker': 'mac-1', 'events': [], 'runs': [
            {'run_id': name, 'task_id': name + '@1', 'kind': 'upload', 'started': at, 'state': 'running'}]}

    def test_first_snapshot_has_every_kind_and_separate_sample_counts(self):
        summary = self.ledger.publish_averages(self.public, self.at)
        self.assertEqual(summary['average_updates']['scheduled_interval_seconds'], 43200)
        self.assertEqual(len(summary['by_kind']), 6)
        row = next(r for r in summary['by_kind'] if r['key'] == 'newsletter')
        for field in ('five_hour_pp', 'weekly_pp'):
            self.assertEqual((row[field]['n'], row[field]['mean']), (1, 2))
        history = self.ledger.average_history()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]['by_kind'], summary['by_kind'])
        self.assertIn('scheduled_12h', history[0]['reasons'])
        self.assertTrue(self.public.exists())

    def test_new_task_recalculates_before_minute_without_diluting_finished_average(self):
        first = self.ledger.publish_averages(self.public, self.at)
        self.ledger.ingest(self.new_task(), self.at + 5)
        updated = self.ledger.publish_averages(self.public, self.at + 6)
        self.assertIsNotNone(updated)
        self.assertIn('new_task', updated['average_updates']['reasons'])
        before = next(r for r in first['by_kind'] if r['key'] == 'newsletter')
        after = next(r for r in updated['by_kind'] if r['key'] == 'newsletter')
        self.assertEqual(after, before)
        upload = next(r for r in updated['by_kind'] if r['key'] == 'upload')
        self.assertEqual(upload['tracked'], 1)
        self.assertEqual(upload['weekly_pp']['n'], 0)
        self.assertIsNone(upload['weekly_pp']['mean'])
        self.assertEqual(len(self.ledger.average_history()), 2)

    def test_unchanged_announcements_do_not_recalculate_or_duplicate_history(self):
        self.ledger.publish_averages(self.public, self.at)
        task = self.new_task()
        self.ledger.ingest(task, self.at + 5)
        self.ledger.publish_averages(self.public, self.at + 6)
        revision = self.ledger.setting('average_pending')['revision']
        self.ledger.ingest(task, self.at + 10)
        self.assertEqual(self.ledger.setting('average_pending')['revision'], revision)
        self.assertIsNone(self.ledger.publish_averages(self.public, self.at + 11))
        self.ledger.publish_averages(self.public, self.at + 70)
        self.assertEqual(len(self.ledger.average_history()), 2)

    def test_completed_task_updates_both_means_and_denominators(self):
        self.ledger.publish_averages(self.public, self.at)
        batch = payload()
        batch['runs'][0].update(run_id='run-b', task_id='task-b@1', started=NOW+710, finished=NOW+730)
        batch['events'][0].update(id='quota-b', run_id='run-b', at=NOW+710)
        batch['events'][0]['windows']['seven_day']['percent'] = 12
        batch['events'][1].update(id='message-b', run_id='run-b', at=NOW+715)
        closing = {**batch['events'][0], 'id': 'quota-b-end', 'at': NOW+740,
                   'windows': {'seven_day': {**batch['events'][0]['windows']['seven_day'], 'percent': 16}}}
        batch['events'].append(closing)
        self.ledger.ingest(batch, NOW+745)
        self.ledger.fleet(both_windows(NOW+750, 16), NOW+750)
        summary = self.ledger.publish_averages(self.public, NOW+751)
        newsletter = next(r for r in summary['by_kind'] if r['key']=='newsletter')
        for field in ('five_hour_pp', 'weekly_pp'):
            self.assertEqual((newsletter[field]['n'], newsletter[field]['mean']), (2, 3))

    def test_new_quota_measurement_recalculates_without_duplicating_equal_averages(self):
        self.ledger.publish_averages(self.public, self.at)
        self.ledger.fleet(both_windows(NOW+705, 12), NOW+705)
        updated = self.ledger.publish_averages(self.public, NOW+706)
        self.assertIn('quota_evidence', updated['average_updates']['reasons'])
        self.assertEqual(len(self.ledger.average_history()), 1)

    def test_fixed_twelve_hour_deadline_survives_events_and_process_restart(self):
        self.ledger.publish_averages(self.public, self.at)
        due = self.at + AVERAGE_SNAPSHOT_SECONDS
        self.ledger.ingest(self.new_task(at=due-2), due-2)
        event = self.ledger.publish_averages(self.public, due-1)
        self.assertEqual(stamp(event['average_updates']['next_scheduled_at']), due)
        self.ledger.db.close()
        self.ledger = Ledger(self.path)
        periodic = self.ledger.publish_averages(self.public, due)
        self.assertIn('scheduled_12h', periodic['average_updates']['reasons'])
        self.assertEqual(stamp(periodic['average_updates']['next_scheduled_at']), due + 43200)
        self.assertEqual([r[0] for r in self.ledger.db.execute('SELECT slot FROM average_snapshots WHERE slot IS NOT NULL ORDER BY slot')], [0, 1])
        self.assertIsNone(self.ledger.publish_averages(self.public, due + 1))

    def test_missed_deadline_captures_current_state_without_fabricating_past_values(self):
        self.ledger.publish_averages(self.public, self.at)
        resumed = self.at + 3 * 43200 + 200
        self.ledger.publish_averages(self.public, resumed)
        latest = self.ledger.average_history()[0]
        self.assertEqual(stamp(latest['captured_at']), resumed)
        self.assertEqual(stamp(latest['scheduled_for']), self.at + 3 * 43200)
        self.assertEqual(self.ledger.db.execute('SELECT COUNT(*) FROM average_snapshots WHERE slot IS NOT NULL').fetchone()[0], 2)

    def test_failed_publication_keeps_event_and_deadline_pending_for_retry(self):
        self.ledger.publish_averages(self.public, self.at)
        self.ledger.ingest(self.new_task(), self.at + 5)
        old = self.ledger.setting('average_refresh')
        with patch('quota_ledger.write_json', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.ledger.publish_averages(self.public, self.at + 6)
        self.assertEqual(self.ledger.setting('average_refresh'), old)
        self.assertEqual(len(self.ledger.average_history()), 1)
        self.assertIn('new_task', self.ledger.setting('average_pending')['reasons'])
        self.assertIsNotNone(self.ledger.publish_averages(self.public, self.at + 7))
        self.assertEqual(len(self.ledger.average_history()), 2)

    def test_event_arriving_during_calculation_is_not_acknowledged_early(self):
        self.ledger.publish_averages(self.public, self.at)
        self.ledger.ingest(self.new_task('first'), self.at + 5)
        original = self.ledger.dashboard
        def concurrent(now):
            summary = original(now)
            other = Ledger(self.path)
            try:
                other.ingest(self.new_task('second'), self.at + 6)
            finally:
                other.db.close()
            return summary
        with patch.object(self.ledger, 'dashboard', side_effect=concurrent):
            self.ledger.publish_averages(self.public, self.at + 7)
        pending = self.ledger.setting('average_pending')
        self.assertGreater(pending['revision'], self.ledger.setting('average_refresh')['revision'])
        next_summary = self.ledger.publish_averages(self.public, self.at + 8)
        self.assertEqual(next(r for r in next_summary['by_kind'] if r['key']=='upload')['tracked'], 2)

    def test_queue_arrivals_trigger_refresh_but_progress_only_updates_do_not(self):
        self.ledger.publish_averages(self.public, self.at)
        data = both_windows(NOW+700, 12)
        data['queue'] = {'tasks': [{'id': 'queued-new', 'workflow': 'newsletter', 'status': 'queued', 'progress': 0}]}
        self.ledger.fleet(data, self.at+5)
        summary = self.ledger.publish_averages(self.public, self.at+6)
        self.assertIn('queue_changed', summary['average_updates']['reasons'])
        data['queue']['tasks'][0].update(progress=50, updatedAt=self.at+7)
        self.ledger.fleet(data, self.at+7)
        self.assertIsNone(self.ledger.publish_averages(self.public, self.at+8))
        data['queue']['tasks'][0]['status'] = 'completed'
        self.ledger.fleet(data, self.at+9)
        self.assertIsNotNone(self.ledger.publish_averages(self.public, self.at+10))

    def test_publisher_lock_and_archive_checksum_protect_history(self):
        self.ledger.publish_averages(self.public, self.at)
        with (self.public.parent/'.average-refresh.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIsNone(self.ledger.publish_averages(self.public, self.at+100))
        snapshot = self.ledger.average_history()[0]
        with self.ledger.db:
            self.ledger.db.execute('UPDATE raw_archives SET payload=? WHERE id=?', (zlib.compress(b'corrupt'), snapshot['id']))
        with self.assertRaises(ValueError):
            self.ledger.average_history()


if __name__ == '__main__':
    unittest.main()
