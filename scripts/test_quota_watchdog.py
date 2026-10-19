import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('quota_watchdog', Path(__file__).with_name('quota_watchdog.py'))
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)

NOW = 1792405000
SERVICE = {'ActiveState': 'active', 'MainPID': '123', 'ActiveEnterTimestampMonotonic': '1000000'}


def summary(age=0):
    from datetime import datetime, timezone
    return {'schema': 2, 'by_kind': [], 'generated_at': datetime.fromtimestamp(NOW-age, timezone.utc).isoformat()}


class WatchdogTests(unittest.TestCase):
    def check(self, data, previous=None, service=None, now=NOW, monotonic=1000):
        return watchdog.assess(data, previous or {}, service or SERVICE, now, monotonic)

    def test_fresh_output_is_healthy_and_clears_failure_streak(self):
        result = self.check(summary(179), {'failures': 9, 'pid': '123', 'status': 'stale'})
        self.assertEqual(result['status'], 'healthy')
        self.assertFalse(result['restart'])
        self.assertEqual(result['failures'], 0)

    def test_two_separate_stale_observations_recover_only_collector(self):
        first = self.check(summary(181))
        self.assertFalse(first['restart'])
        same = self.check(summary(181), first, now=NOW+10)
        self.assertEqual(same['failures'], 1)
        second = self.check(summary(181), first, now=NOW+30)
        self.assertTrue(second['restart'])

    def test_intentional_stop_and_startup_grace_are_respected(self):
        stopped = self.check({}, service={**SERVICE, 'ActiveState': 'inactive'})
        self.assertEqual(stopped['status'], 'inactive')
        self.assertFalse(stopped['restart'])
        self.assertEqual(self.check({}, monotonic=100)['status'], 'starting')

    def test_new_pid_cannot_inherit_old_failure_streak(self):
        first = self.check(summary(181))
        result = self.check({}, first, {**SERVICE, 'MainPID': '456'}, now=NOW+30)
        self.assertEqual(result['failures'], 1)
        self.assertFalse(result['restart'])

    def test_restart_cooldown_prevents_restart_storms(self):
        first = {**self.check({}), 'last_restart': NOW-599}
        self.assertFalse(self.check({}, first)['restart'])
        self.assertTrue(self.check({}, first, now=NOW+30)['restart'])

    def test_missing_invalid_and_future_data_are_never_healthy(self):
        for value in ({}, {'generated_at': 'invalid'}, summary(-600), {**summary(), 'schema': 1}):
            first = self.check(value)
            self.assertEqual(first['status'], 'stale')
            self.assertTrue(self.check(value, first, now=NOW+30)['restart'])

    def test_restart_command_is_fixed_to_passive_service_and_persists_cooldown(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder)/'state.json'
            previous = self.check({})
            previous['checked_at'] -= 30
            file.write_text(json.dumps(previous))
            argv = ['quota_watchdog.py', '--state', str(file), '--summary', str(Path(folder)/'missing.json')]
            with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', io.StringIO()), \
                    patch.object(watchdog.time, 'time', return_value=NOW), \
                    patch.object(watchdog.time, 'monotonic', return_value=1000), \
                    patch.object(watchdog.subprocess, 'check_output', return_value='\n'.join(k+'='+v for k,v in SERVICE.items())), \
                    patch.object(watchdog.subprocess, 'run') as restart:
                watchdog.main()
            self.assertEqual(restart.call_args.args[0], ['systemctl', 'restart', 'max-monitor-quota.service'])
            state = json.loads(file.read_text())
            self.assertEqual(state['last_restart'], NOW)
            self.assertEqual(state['status'], 'restarted')


if __name__ == '__main__':
    unittest.main()
