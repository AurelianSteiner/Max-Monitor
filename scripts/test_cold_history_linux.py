"""Real mount/release acceptance; skipped outside an admin Linux mount namespace."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from cold_history import capture, verify, digest
from mount_cold_history import activate


def can_mount():
    if sys.platform != 'linux' or os.geteuid() != 0 or not shutil.which('mksquashfs'):
        return False
    status = dict(row.split(':',1) for row in Path('/proc/self/status').read_text().splitlines() if ':' in row)
    return bool(int(status['CapEff'].strip(),16) & (1 << 21))


@unittest.skipUnless(can_mount(), 'requires Linux CAP_SYS_ADMIN and squashfs-tools')
class MountedHistoryTests(unittest.TestCase):
    def test_verified_overlay_releases_backing_files_without_changing_visible_data(self):
        for with_xattrs in (False, True):
            with self.subTest(with_xattrs=with_xattrs):
                self.check_overlay(with_xattrs)

    def check_overlay(self, with_xattrs):
        with tempfile.TemporaryDirectory(prefix='cold-mount-proof-') as folder:
            root = Path(folder)
            source, mounted = root/'source', root/'mounted'
            source.mkdir(mode=0o700)
            mounted.mkdir()
            original = bytes(range(256))*500
            (source/'binary').write_bytes(original)
            os.link(source/'binary',source/'hardlink')
            (source/'link').symlink_to('binary')
            (source/'empty').touch()
            if with_xattrs:
                os.setxattr(source/'binary','user.proof',b'full metadata')
                os.setxattr(source,'user.root-proof',b'root directory metadata')
            db = sqlite3.connect(str(source/'proof.sqlite'))
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('create table proof(value text)')
            db.execute('insert into proof values(?)',('full original text ä',))
            db.commit()
            db.close()
            metadata, image = root/'metadata.gz', root/'proof.squashfs'
            capture(source,metadata)
            subprocess.run(['mksquashfs',str(source),str(image),'-noappend','-comp','zstd','-Xcompression-level','15','-processors','1','-quiet'],check=True,capture_output=True)
            subprocess.run(['mount','-o','loop,ro,nodev,nosuid,noexec',str(image),str(mounted)],check=True)
            try:
                proof = verify(source,mounted,metadata)
                proof.update(source_root=str(source),image_sha256=digest(image))
                verification = root/'verify.json'
                verification.write_text(json.dumps(proof))
                fstab = root/'fstab'
                fstab.write_text('# isolated acceptance fixture\n')
                receipt = activate(source,image,metadata,verification,root/'activation',fstab)
                self.assertTrue(receipt['uncompressed_released'])
                self.assertEqual((source/'binary').read_bytes(),original)
                self.assertEqual((source/'binary').stat().st_ino,(source/'hardlink').stat().st_ino)
                if with_xattrs:
                    self.assertEqual(os.getxattr(source/'binary','user.proof'),b'full metadata')
                    self.assertEqual(os.getxattr(source,'user.root-proof'),b'root directory metadata')
                db = sqlite3.connect((source/'proof.sqlite').as_uri()+'?mode=ro',uri=True)
                self.assertEqual(db.execute('select value from proof').fetchone()[0],'full original text ä')
                db.close()
                self.assertEqual(subprocess.check_output(['findmnt','-n','-o','FSTYPE','--target',str(source)],text=True).strip(),'overlay')
                (source/'new-reader-receipt').write_text('normal writes still work')
                self.assertTrue((root/'activation'/'upper'/'new-reader-receipt').is_file())
            finally:
                for path in (source,mounted,root/'activation'/'original',root/'activation'/'lower'):
                    while subprocess.run(['mountpoint','-q',str(path)]).returncode == 0:
                        subprocess.run(['umount',str(path)],check=True)


if __name__ == '__main__':
    unittest.main()
