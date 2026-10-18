import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runtime', Path(__file__).with_name('install-runtime-release.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'root'
        (self.root / 'scripts').mkdir(parents=True)
        (self.root / 'team-server').mkdir()
        self.live = self.root / 'team-server/server.js'
        self.live.write_text('old bytes')
        self.helper = self.root / 'scripts/preserved.sh'
        self.helper.write_text('keep bytes')
        data = b'module.exports = {};'
        self.payload = {'revision': 'a' * 40, 'manifest': {'schema': 1, 'files': ['team-server/server.js']},
                        'files': {'team-server/server.js': {'base64': base64.b64encode(data).decode(),
                                  'sha256': hashlib.sha256(data).hexdigest()}},
                        'baseline': {'team-server/server.js': runtime.digest(self.live),
                                     'scripts/preserved.sh': runtime.digest(self.helper)}}
        self.calls = []

    def command(self, args, **kwargs):
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    def install(self, **kwargs):
        return runtime.install(self.payload, self.root, Path(self.temp.name) / 'backups',
                               run=self.command, **kwargs)

    def test_exact_release_receipt_preserves_helpers_and_never_starts_workers(self):
        result = self.install()
        self.assertTrue(result['verifiedSource'])
        self.assertEqual('a' * 40, result['sourceRevision'])
        self.assertEqual('keep bytes', self.helper.read_text())
        receipt = json.loads((self.root / 'relay-release.json').read_text())
        self.assertEqual(runtime.digest(self.live), receipt['sourceFiles']['team-server/server.js'])
        self.assertTrue(all(not any('newsletter' in str(arg) for arg in call) for call in self.calls))

    def test_drift_or_manifest_mismatch_aborts_before_any_mutation(self):
        self.live.write_text('new operator bytes')
        with self.assertRaisesRegex(ValueError, 'Live source changed'):
            self.install()
        self.assertEqual([], self.calls)
        self.assertFalse((self.root / 'relay-release.json').exists())
        self.payload['manifest']['files'] = ['scripts/missing.js']
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.install()

    def test_failed_restart_restores_original_source_receipt_and_helpers(self):
        def fake(args, **kwargs):
            self.calls.append(args)
            if args[:2] == ['systemctl', 'restart'] and not getattr(self, 'failed', False):
                self.failed = True
                raise RuntimeError('simulated restart failure')
            return subprocess.CompletedProcess(args, 0)
        self.command = fake
        with self.assertRaisesRegex(RuntimeError, 'simulated'):
            self.install()
        self.assertEqual('old bytes', self.live.read_text())
        self.assertEqual('keep bytes', self.helper.read_text())
        self.assertFalse((self.root / 'relay-release.json').exists())

    def test_dry_run_only_and_unsafe_paths_or_digest_cannot_install(self):
        self.assertTrue(self.install(dry_run=True)['dryRun'])
        self.assertEqual([], self.calls)
        self.assertEqual('old bytes', self.live.read_text())
        self.payload['files']['team-server/server.js']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'digest'):
            self.install()
        for value in ['../secrets', 'scripts/../../file', '/etc/file', 'scripts/a/b.js']:
            self.assertFalse(runtime.safe_path(value))


if __name__ == '__main__':
    unittest.main()
