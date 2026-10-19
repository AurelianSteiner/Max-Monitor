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
from unittest.mock import patch
import mmap
import auto_cold_storage as auto
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


@unittest.skipUnless(can_mount(), 'requires Linux CAP_SYS_ADMIN and squashfs-tools')
class AutomaticMountedHistoryTests(unittest.TestCase):
    def fixture(self, root):
        source=root/'source';source.mkdir(mode=0o700)
        (source/'data').write_bytes(b'full original text, including all records\n'*100000)
        db=sqlite3.connect(str(source/'proof.sqlite'))
        db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE proof(value TEXT)')
        db.execute('INSERT INTO proof VALUES (?)',('keine Daten verlieren ä',));db.commit();db.close()
        fstab=root/'fstab';fstab.write_text('# isolated automatic test\n')
        return source,fstab

    def cleanup_mounts(self, root):
        # Children first. Include a retained backing bind after a final-guard failure.
        for target in sorted(auto.mounts(),key=lambda p:len(p.parts),reverse=True):
            if root in target.parents:
                subprocess.run(['umount',str(target)],check=True)

    def test_automatic_pipeline_preserves_open_reader_and_normal_sqlite_access(self):
        with tempfile.TemporaryDirectory(prefix='automatic-cold-') as folder:
            root=Path(folder);source,fstab=self.fixture(root)
            try:
                with (source/'data').open('rb') as reader:
                    result=auto.compress(source,auto.scan(source,auto.mounts()),root/'store',fstab)
                    self.assertEqual(result['status'],'compressed')
                    self.assertEqual(reader.read(),(source/'data').read_bytes())
                db=sqlite3.connect((source/'proof.sqlite').as_uri()+'?mode=ro',uri=True)
                self.assertEqual(db.execute('SELECT value FROM proof').fetchone()[0],'keine Daten verlieren ä');db.close()
                (source/'new-write').write_text('a later write still works')
                self.assertEqual((source/'new-write').read_text(),'a later write still works')
                receipt=json.loads(Path(result['receipt']).read_text())
                self.assertTrue(receipt['uncompressed_released'])
            finally:self.cleanup_mounts(root)

    def test_a_running_writer_or_shared_mapping_is_never_repacked(self):
        with tempfile.TemporaryDirectory(prefix='automatic-cold-') as folder:
            root=Path(folder);source,fstab=self.fixture(root);observed=auto.scan(source,set())
            with (source/'data').open('r+b') as writer:
                with self.assertRaises(auto.Deferred):auto.compress(source,observed,root/'store',fstab)
                writer.write(b'job continues');writer.flush()
                shared=mmap.mmap(writer.fileno(),0)
            try:
                with self.assertRaisesRegex(auto.Deferred,'shared_writable_mapping'):
                    auto.compress(source,auto.scan(source,set()),root/'store',fstab)
            finally:shared.close()
            self.assertFalse((root/'store').exists())
            self.assertTrue((source/'data').read_bytes().startswith(b'job continues'))

    def test_a_change_during_build_keeps_both_original_and_new_data(self):
        with tempfile.TemporaryDirectory(prefix='automatic-cold-') as folder:
            root=Path(folder);source,fstab=self.fixture(root)
            original_verify=auto.verify
            def changed(*args,**kwargs):
                (source/'late-write').write_text('new original data')
                return original_verify(*args,**kwargs)
            try:
                with patch.object(auto,'verify',side_effect=changed):
                    with self.assertRaises(ValueError):
                        auto.compress(source,auto.scan(source,set()),root/'store',fstab)
                self.assertEqual((source/'late-write').read_text(),'new original data')
                self.assertFalse(os.path.ismount(source))
            finally:self.cleanup_mounts(root)

    def test_failed_final_guard_retains_image_originals_and_later_overlay_writes(self):
        with tempfile.TemporaryDirectory(prefix='automatic-cold-') as folder:
            root=Path(folder);source,fstab=self.fixture(root)
            try:
                with patch.object(auto,'assert_namespaces',side_effect=auto.Deferred('simulated visibility failure')):
                    with self.assertRaisesRegex(RuntimeError,'Retained archive and originals'):
                        auto.compress(source,auto.scan(source,set()),root/'store',fstab)
                attempt=next((root/'store').iterdir())
                self.assertTrue((attempt/'activation/original/data').is_file())
                self.assertEqual((source/'data').read_bytes(),(attempt/'activation/original/data').read_bytes())
                (source/'later').write_text('must remain visible')
                with self.assertRaises(RuntimeError):auto.pending_operations(root/'store')
                self.assertEqual((source/'later').read_text(),'must remain visible')
            finally:self.cleanup_mounts(root)

    def test_failure_immediately_after_publication_keeps_persistent_overlay(self):
        with tempfile.TemporaryDirectory(prefix='automatic-cold-') as folder:
            root=Path(folder);source,fstab=self.fixture(root)
            check_output=subprocess.check_output
            def fail_visibility(args,**kwargs):
                if args[:4]==['findmnt','-n','-o','FSTYPE'] and args[-1]==str(source):
                    return 'unexpected-filesystem\n'
                return check_output(args,**kwargs)
            try:
                with patch.object(subprocess,'check_output',side_effect=fail_visibility):
                    with self.assertRaisesRegex(RuntimeError,'Retained archive and originals'):
                        auto.compress(source,auto.scan(source,set()),root/'store',fstab)
                self.assertTrue(os.path.ismount(source))
                self.assertIn('overlay '+str(source)+' overlay',fstab.read_text())
                attempt=next((root/'store').iterdir())
                self.assertTrue((attempt/'activation/original/data').is_file())
                (source/'later').write_text('survives publication failure')
                self.assertEqual((attempt/'activation/upper/later').read_text(),'survives publication failure')
            finally:self.cleanup_mounts(root)


if __name__ == '__main__':
    unittest.main()
