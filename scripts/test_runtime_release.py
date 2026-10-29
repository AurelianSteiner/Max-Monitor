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
    def test_complete_repository_manifest_installs_and_reads_back_including_new_directory(self):
        repo = Path(__file__).resolve().parent.parent
        manifest = json.loads((repo / 'Config/runtime-release-files.json').read_text())
        self.payload['manifest'] = manifest
        self.payload['files'] = {}
        self.payload['baseline'] = {}
        for rel in manifest['files']:
            data = (repo / rel).read_bytes()
            self.payload['files'][rel] = {'base64': base64.b64encode(data).decode(),
                                          'sha256': hashlib.sha256(data).hexdigest()}
            self.payload['baseline'][rel] = runtime.digest(self.root / rel)
        self.assertFalse((self.root / 'Config').exists())
        self.assertTrue(self.install(dry_run=True)['dryRun'])
        self.assertEqual([], self.calls)
        result = self.install()
        self.assertEqual(len(manifest['files']), len(result['sourceFiles']))
        for rel, digest in result['sourceFiles'].items():
            self.assertEqual(digest, runtime.digest(self.root / rel), rel)

    def test_runtime_asset_paths_are_explicit_and_cannot_escape_public(self):
        self.assertTrue(runtime.safe_path('Config/runtime-release-files.json'))
        self.assertFalse(runtime.safe_path('Config/Info.plist'))
        self.assertTrue(runtime.safe_path('team-server/public/consumption.js'))
        self.assertTrue(runtime.safe_path('team-server/public/dashboard.css'))
        for value in ['team-server/public/../../secrets.json','team-server/public/other/private.js','team-server/public/secret.json','/etc/passwd']:
            self.assertFalse(runtime.safe_path(value))

    def test_newsletter_source_installs_only_with_its_own_revision_and_never_credentials(self):
        # Prinz 12451cu4101 (29.10.2026): the copied worker rules stayed at 17.10. because
        # the runtime release never carried them; the queue then hid automatic uploads.
        policy = b"module.exports = { uploadPolicy() { return { manual: false }; } };"
        rules = b'{"customers": []}'
        files = {'newsletter-source/src/upload-policy.js': policy, 'newsletter-source/config/manual-uploads.json': rules}
        for rel, data in files.items():
            self.payload['files'][rel] = {'base64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}
            self.payload['baseline'][rel] = None
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.install(dry_run=True)
        self.payload['newsletterSource'] = {'revision': 'b' * 40, 'files': sorted(files)}
        result = self.install()
        self.assertEqual('b' * 40, result['newsletterSourceRevision'])
        self.assertEqual(policy, (self.root / 'newsletter-source/src/upload-policy.js').read_bytes())
        self.assertEqual(rules, (self.root / 'newsletter-source/config/manual-uploads.json').read_bytes())
        self.assertIn('newsletter-source/src/upload-policy.js', result['sourceFiles'])
        for value in ['newsletter-source/config/worker.local.json', 'newsletter-source/src/../config.js',
                      'newsletter-source/node_modules/x.js', 'newsletter-source/src/a/b.js', 'newsletter-source/config/x.js']:
            self.assertFalse(runtime.safe_path(value), value)
        self.assertTrue(runtime.safe_path('newsletter-source/src/hub-transport.js'))
        self.payload['newsletterSource']['revision'] = 'main'
        with self.assertRaisesRegex(ValueError, 'newsletter source'):
            self.install(dry_run=True)

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
