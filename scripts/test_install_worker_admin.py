import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest


class WorkerAdminInstallTest(unittest.TestCase):
    def test_maintenance_only_mac_updates_and_runs_without_newsletter_launchagent(self):
        self.install(False)

    def test_existing_launchagent_runtime_is_preserved_even_with_spaces(self):
        self.install(True)

    def install(self, with_plist):
        with tempfile.TemporaryDirectory(prefix='maintenance install ') as directory:
            home = Path(directory)
            node = home / ('Runtime With Spaces/node' if with_plist else '.local/share/ai-newsletter-runtime/bin/node')
            node.parent.mkdir(parents=True)
            node.write_text('#!/bin/bash\nprintf "%s\\n" "$@" >> "$HOME/node-calls"\n')
            node.chmod(0o700)
            plist = home / 'Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist'
            if with_plist:
                plist.parent.mkdir(parents=True)
                plist.write_bytes(plistlib.dumps({'ProgramArguments': [str(node), '/existing/src/cli.js']}))
            env = {**os.environ, 'HOME': str(home)}
            source = Path(__file__).with_name('install-worker-admin.sh')
            subprocess.run(['/bin/bash', str(source)], env=env, check=True, capture_output=True)
            wrapper = home / '.local/bin/max-monitor-worker'
            self.assertNotIn('LaunchAgents', wrapper.read_text())
            subprocess.run([str(wrapper), 'list'], env=env, check=True, capture_output=True)
            self.assertEqual((home/'node-calls').read_text().splitlines()[-1], 'list')
            self.assertEqual(plist.exists(), with_plist)
            self.assertEqual((home/'.local/share/max-monitor-admin/tool/scripts/member-remote.py').read_bytes(),
                             source.with_name('member-remote.py').read_bytes())


if __name__ == '__main__':
    unittest.main()
