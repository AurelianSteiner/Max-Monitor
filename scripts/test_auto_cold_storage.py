import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import auto_cold_storage as auto
from cold_history import capture
import install_cold_storage as installer


class AutomaticStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root/'archive-20260101'
        self.source.mkdir()
        (self.source/'data').write_bytes(b'complete original data\n'*60000)

    def test_only_dated_real_directories_are_discovered(self):
        (self.root/'active-database').mkdir()
        (self.root/'archive-20260102').symlink_to(self.source, target_is_directory=True)
        (self.root/'archive-20260103').write_text('not a directory')
        self.assertEqual(list(auto.candidates(((self.root,r'archive-\d{8}'),))), [self.source])

    def test_age_alone_never_authorizes_compression(self):
        now = time.time()
        current = auto.scan(self.source,set())
        current['latest_change'] = now-auto.MIN_AGE-1
        first = auto.observe({},current,now)
        self.assertFalse(auto.ready(first,now))
        second = auto.observe(first,current,now+auto.STABLE_FOR)
        self.assertTrue(auto.ready(second,now+auto.STABLE_FOR))
        current['fingerprint'] = 'a different revision'
        changed = auto.observe(second,current,now+auto.STABLE_FOR)
        self.assertFalse(auto.ready(changed,now+auto.STABLE_FOR))

    def test_recent_activity_and_poor_savings_block_repeated_work(self):
        now = time.time()
        current = auto.scan(self.source,set())
        current['unchanged_since'] = now-auto.STABLE_FOR-1
        self.assertFalse(auto.ready(current,now))
        current['latest_change'] = now-auto.MIN_AGE-1
        current['no_savings'] = True
        same = auto.observe(current,current,now)
        self.assertFalse(auto.ready(same,now))

    def test_mounts_external_hardlinks_and_special_files_are_excluded(self):
        for mounted in [{self.source},{self.source/'nested'}]:
            with self.assertRaises(auto.Deferred):
                auto.scan(self.source,mounted)
        os.link(self.source/'data',self.root/'outside')
        with self.assertRaisesRegex(auto.Deferred,'hardlinks_outside'):
            auto.scan(self.source,set())
        (self.root/'outside').unlink()
        os.mkfifo(self.source/'fifo')
        with self.assertRaisesRegex(auto.Deferred,'special_file'):
            auto.scan(self.source,set())

    def test_touching_bytes_with_restored_mtime_still_resets_observation(self):
        before = auto.scan(self.source,set())
        file = self.source/'data'
        s = file.stat()
        file.write_bytes(b'x'*s.st_size)
        os.utime(file,ns=(s.st_atime_ns,s.st_mtime_ns))
        self.assertNotEqual(before['fingerprint'],auto.scan(self.source,set())['fingerprint'])

    def test_catalog_rejects_post_capture_write_and_added_file(self):
        metadata = self.root/'metadata.gz'
        capture(self.source,metadata)
        auto.assert_catalog(self.source,metadata)
        (self.source/'late').write_text('must not be lost')
        with self.assertRaises(auto.Deferred):
            auto.assert_catalog(self.source,metadata)
        self.assertEqual((self.source/'late').read_text(),'must not be lost')

    def fake_process(self,flags='0100000',mapping=''):
        proc = self.root/'proc'; process = proc/'123'
        (process/'fd').mkdir(parents=True);(process/'fdinfo').mkdir()
        (process/'cwd').symlink_to(self.root,target_is_directory=True)
        (process/'root').symlink_to('/',target_is_directory=True)
        (process/'maps').write_text(mapping)
        (process/'fd/4').symlink_to(self.source/'data')
        (process/'fdinfo/4').write_text('flags:\t'+flags+'\n')
        return proc,process

    def test_readers_are_allowed_but_writers_and_directory_handles_are_not(self):
        proc,process = self.fake_process()
        auto.assert_idle(self.source,proc=proc)
        (process/'fdinfo/4').write_text('flags:\t0100002\n')
        with self.assertRaisesRegex(auto.Deferred,'open_writer'):
            auto.assert_idle(self.source,proc=proc)
        (process/'fdinfo/4').write_text('flags:\t0100000\n')
        (process/'fd/4').unlink();(process/'fd/4').symlink_to(self.source,target_is_directory=True)
        with self.assertRaisesRegex(auto.Deferred,'open_writer_or_directory'):
            auto.assert_idle(self.source,proc=proc)

    def test_working_directory_and_shared_write_mapping_are_busy(self):
        proc,process = self.fake_process()
        (process/'cwd').unlink();(process/'cwd').symlink_to(self.source,target_is_directory=True)
        with self.assertRaisesRegex(auto.Deferred,'working_directory'):
            auto.assert_idle(self.source,proc=proc)
        (process/'cwd').unlink();(process/'cwd').symlink_to(self.root,target_is_directory=True)
        device = self.source.stat().st_dev
        # os.major/minor are available on both test platforms.
        (process/'maps').write_text('1000-2000 rw-s 00000000 %x:%x 42 %s\n' %
                                   (os.major(device),os.minor(device),self.source/'data'))
        with self.assertRaisesRegex(auto.Deferred,'shared_writable'):
            auto.assert_idle(self.source,proc=proc)

    def test_no_space_and_changed_sources_never_start_image_builder(self):
        observed = auto.scan(self.source,set())
        with patch.object(auto,'assert_idle'),patch.object(auto,'mounts',return_value=set()),patch.object(auto.subprocess,'run') as command:
            (self.source/'data').write_text('new content')
            with self.assertRaisesRegex(auto.Deferred,'changed_since'):
                auto.compress(self.source,observed,self.root/'store')
            observed = auto.scan(self.source,set())
            with patch.object(auto.shutil,'disk_usage',return_value=type('Disk',(),{'total':10**12,'free':1})()):
                with self.assertRaisesRegex(auto.Deferred,'temporary_space'):
                    auto.compress(self.source,observed,self.root/'store')
            command.assert_not_called()
        self.assertEqual((self.source/'data').read_text(),'new content')

    def test_interrupted_staging_is_cleaned_but_activation_is_never_deleted(self):
        store=self.root/'store';attempt=store/'attempt';attempt.mkdir(parents=True)
        (attempt/'operation.json').write_text(json.dumps({'source':str(self.source),'phase':'building'}))
        (attempt/'partial-image').write_bytes(b'partial')
        with patch.object(auto,'mounts',return_value=set()):
            auto.pending_operations(store)
        self.assertFalse(attempt.exists())
        attempt.mkdir();(attempt/'operation.json').write_text(json.dumps({'source':str(self.source),'phase':'activating'}))
        (attempt/'retained-original').write_text('do not delete')
        with self.assertRaisesRegex(RuntimeError,'Retained unfinished'):
            auto.pending_operations(store)
        self.assertEqual((attempt/'retained-original').read_text(),'do not delete')
        self.assertTrue((self.source/'data').exists())

    def test_preview_cannot_advance_observations_or_create_state(self):
        state=self.root/'new-state'
        with patch.object(auto,'mounts',return_value=set()):
            result=auto.run(state,self.root/'store',((self.root,r'archive-\d{8}'),),apply=False)
        self.assertEqual(result['status'],'healthy')
        self.assertFalse(state.exists())

    def test_low_disk_is_not_reported_as_healthy_even_without_candidates(self):
        with patch.object(auto.shutil,'disk_usage',return_value=type('Disk',(),{'total':10**12,'free':1})()):
            with self.assertRaisesRegex(RuntimeError,'safety reserve'):
                auto.run(self.root/'state',self.root/'store',(),apply=False)

    def test_a_scheduled_run_compresses_at_most_one_eligible_archive(self):
        other=self.root/'archive-20260102';other.mkdir();(other/'data').write_bytes(b'x'*2000000)
        now=time.time()+auto.MIN_AGE+auto.STABLE_FOR+10
        state=self.root/'state';state.mkdir()
        observations={str(p):{**auto.scan(p,set()),'unchanged_since':now-auto.STABLE_FOR-1}
                      for p in (self.source,other)}
        auto.save(state/'observations.json',observations)
        with patch.object(auto,'mounts',return_value=set()),patch.object(auto,'compress',return_value={'status':'compressed'}) as compress:
            result=auto.run(state,self.root/'store',((self.root,r'archive-\d{8}'),),now=now)
        self.assertEqual(result['status'],'healthy')
        self.assertEqual(compress.call_count,1)
        self.assertIn('ready',[x['status'] for x in result['results']])

    def test_unfinished_recovery_and_audit_are_not_archived(self):
        history=self.root/'rs-hub-recovery-history-20260101';snapshot=history/'recovery-1';snapshot.mkdir(parents=True)
        with self.assertRaises(auto.Deferred):auto.assert_complete(history)
        (snapshot/'manifest.json').write_text('{"complete":')
        with self.assertRaises(auto.Deferred):auto.assert_complete(history)
        (snapshot/'manifest.json').write_text('{"complete":true}')
        auto.assert_complete(history)
        audit=self.root/'feedback-audits/filestage-20260101-a';audit.mkdir(parents=True)
        with self.assertRaises(auto.Deferred):auto.assert_complete(audit)
        (audit/'completion-proof.json').write_text('{"collectionComplete":true}')
        auto.assert_complete(audit)

    def test_installer_has_only_a_separate_bounded_service(self):
        units=installer.units()
        service=units['max-monitor-cold-storage.service']
        self.assertIn('CPUQuota=200%',service)
        self.assertIn('MemoryMax=8G',service)
        self.assertIn('IOSchedulingClass=idle',service)
        self.assertNotIn('\nPrivateTmp=',service)
        self.assertNotIn('restart',service)
        self.assertIn('Persistent=true',units['max-monitor-cold-storage.timer'])


if __name__ == '__main__':
    unittest.main()
