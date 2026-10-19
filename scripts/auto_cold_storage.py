#!/usr/bin/env python3
"""Losslessly compress quiescent, dated RS Hub archives; never manage live jobs."""
import argparse
from collections import Counter
from contextlib import nullcontext
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import uuid

from cold_history import attributes, capture, digest, entries, verify
from mount_cold_history import activate

STATE = Path('/var/lib/max-monitor-cold-storage')
STORE = Path('/var/lib/rs-hub-compressed-history/automatic')
FAMILIES = (
    (Path('/var/lib'), r'rs-hub-recovery-history-\d{8}'),
    (Path('/opt/rs-hub/data/feedback-audits'), r'filestage-\d{8}-[A-Za-z0-9._-]+'),
    (Path('/opt/rs-hub/data/customer-intelligence'), r'feedback-reconciliation-\d{8}'),
    (Path('/opt/rs-hub/data/customer-intelligence/source-originals'), r'[A-Za-z0-9._-]*\d{4}-?\d{2}-?\d{2}(?:-[A-Za-z0-9._-]+)?'),
)
MIN_AGE = 72 * 3600
STABLE_FOR = 24 * 3600
MIN_BYTES = 1024 * 1024
RESERVE = 10 * 1024**3


class Deferred(ValueError):
    """A safety condition prevents compression; keep all source data."""


def save(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name+'.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def mounts():
    return {Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4]))
            for line in Path('/proc/self/mountinfo').read_text().splitlines()}


def candidates(families=FAMILIES):
    for parent, pattern in families:
        if not parent.exists():
            continue
        for source in sorted(parent.iterdir()):
            if re.fullmatch(pattern, source.name) and source.is_dir() and not source.is_symlink():
                if source.resolve() != source.absolute():
                    continue
                yield source


def scan(source, mounted):
    if any(path == source or source in path.parents for path in mounted):
        raise Deferred('already_mounted_or_nested_mount')
    fingerprint = hashlib.sha256()
    inodes, links = {}, Counter()
    latest, count = 0, 0
    device = source.stat().st_dev
    for relative, path in entries(source):
        s = path.lstat()
        if s.st_dev != device or not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode)):
            raise Deferred('special_file_or_other_filesystem')
        row = [str(relative), s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns,
               s.st_ctime_ns, s.st_dev, s.st_ino, s.st_nlink, attributes(path)]
        if stat.S_ISLNK(s.st_mode):
            row.append(os.readlink(path))
        fingerprint.update(json.dumps(row, sort_keys=True, separators=(',', ':')).encode()+b'\n')
        latest = max(latest, s.st_mtime_ns/1e9, s.st_ctime_ns/1e9)
        if stat.S_ISREG(s.st_mode):
            key = (s.st_dev, s.st_ino)
            inodes[key] = (s.st_size, s.st_blocks*512, s.st_nlink)
            links[key] += 1
        count += 1
    if any(links[key] != value[2] for key, value in inodes.items()):
        raise Deferred('hardlinks_outside_archive')
    return {'fingerprint': fingerprint.hexdigest(), 'latest_change': latest, 'entries': count,
            'logical_bytes': sum(x[0] for x in inodes.values()),
            'allocated_bytes': sum(x[1] for x in inodes.values())}


def assert_complete(source):
    def completed(path, field):
        try:
            value = json.loads(path.read_text())
            return isinstance(value, dict) and value.get(field) is True
        except (FileNotFoundError, json.JSONDecodeError):
            return False

    if source.name.startswith('rs-hub-recovery-history-'):
        snapshots = list(source.glob('recovery-*'))
        if not snapshots or any(p.is_symlink() or not p.is_dir()
                                or not completed(p/'manifest.json', 'complete') for p in snapshots):
            raise Deferred('recovery_snapshot_not_complete')
    elif source.parent.name == 'feedback-audits':
        proof = source/'completion-proof.json'
        if not completed(proof, 'collectionComplete'):
            raise Deferred('audit_not_complete')


def observe(previous, current, now):
    same = previous.get('fingerprint') == current['fingerprint']
    since = previous.get('unchanged_since', now) if same else now
    return {**current, 'unchanged_since': since, 'last_seen': now,
            'no_savings': bool(same and previous.get('no_savings'))}


def ready(observation, now):
    return (now-observation['latest_change'] >= MIN_AGE
            and now-observation['unchanged_since'] >= STABLE_FOR
            and observation['allocated_bytes'] >= MIN_BYTES and not observation.get('no_savings'))


def under(path, root):
    return path == root or root in path.parents


def assert_idle(source, old=None, proc=Path('/proc')):
    roots = [source] + ([old] if old else [])
    original_device = (old or source).stat().st_dev
    for process in proc.glob('[0-9]*'):
        try:
            for anchor in ('cwd', 'root'):
                cwd = Path(os.readlink(process/anchor).removesuffix(' (deleted)'))
                if any(under(cwd, root) for root in roots) and (process/anchor).stat().st_dev == original_device:
                    raise Deferred('active_working_directory')
            for line in (process/'maps').read_text().splitlines():
                fields = line.split(maxsplit=5)
                if len(fields) < 6 or fields[1][1] != 'w' or fields[1][3] != 's':
                    continue
                path = Path(fields[5].removesuffix(' (deleted)'))
                device = os.makedev(*(int(x, 16) for x in fields[3].split(':')))
                if device == original_device and any(under(path, root) for root in roots):
                    raise Deferred('shared_writable_mapping')
            for fd in (process/'fd').iterdir():
                try:
                    path = Path(os.readlink(fd).removesuffix(' (deleted)'))
                    if not any(under(path, root) for root in roots):
                        continue
                    s = fd.stat()
                    if s.st_dev != original_device:
                        continue  # A new reader/writer uses the mounted overlay.
                    info = dict(line.split(':', 1) for line in (process/'fdinfo'/fd.name).read_text().splitlines() if ':' in line)
                    flags = int(info['flags'].strip(), 8)
                    if stat.S_ISDIR(s.st_mode) or flags & os.O_ACCMODE != os.O_RDONLY:
                        raise Deferred('open_writer_or_directory')
                except (FileNotFoundError, ProcessLookupError):
                    continue
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            raise Deferred('cannot_inspect_process') from error


def assert_namespaces(source, proc=Path('/proc')):
    expected = source.stat()
    for process in proc.glob('[0-9]*'):
        try:
            visible = (process/'root'/source.relative_to('/')).stat()
            if (visible.st_dev, visible.st_ino) != (expected.st_dev, expected.st_ino):
                raise Deferred('mount_namespace_does_not_see_archive')
        except (FileNotFoundError, ProcessLookupError):
            continue  # Includes isolated containers with no such canonical path.
        except PermissionError as error:
            raise Deferred('cannot_inspect_mount_namespace') from error


def assert_catalog(source, metadata):
    count = 0
    with gzip.open(metadata, 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            path = Path(row['path'])
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe metadata path')
            s = (source/path).lstat()
            if (s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_dev, s.st_ino) != \
                    tuple(row[key] for key in ('mode','uid','gid','size','mtime_ns','ctime_ns','device','inode')):
                raise Deferred('archive_changed_during_compression')
            count += 1
    if sum(1 for _ in entries(source)) != count:
        raise Deferred('archive_entries_changed')


def space_required(logical, total):
    return int(logical*1.05)+max(RESERVE, int(total*.05))


def compress(source, observed, store=STORE, fstab=Path('/etc/fstab')):
    assert_idle(source)
    if scan(source, mounts())['fingerprint'] != observed['fingerprint']:
        raise Deferred('archive_changed_since_observation')
    store.mkdir(mode=0o700, parents=True, exist_ok=True)
    disk = shutil.disk_usage(store)
    if disk.free < space_required(observed['logical_bytes'], disk.total):
        raise Deferred('insufficient_temporary_space')
    attempt = store/(hashlib.sha256(str(source).encode()).hexdigest()[:16]+'-'+uuid.uuid4().hex)
    attempt.mkdir(mode=0o700)
    metadata, image, verification = attempt/'metadata.jsonl.gz', attempt/'history.squashfs', attempt/'verified.json'
    save(attempt/'operation.json', {'source': str(source), 'phase': 'building', 'started_at': time.time()})
    stage = attempt/'verify-mount'
    stage.mkdir(mode=0o700)
    try:
        capture(source, metadata)
        with (attempt/'build.log').open('wb') as log:
            subprocess.run(['mksquashfs', str(source), str(image), '-noappend', '-comp', 'zstd',
                            '-Xcompression-level', '15', '-b', '1M', '-processors', '2', '-mem', '1G', '-no-progress', '-quiet'],
                           check=True, stdout=log, stderr=subprocess.STDOUT)
        if image.stat().st_size+metadata.stat().st_size > observed['allocated_bytes']*.9:
            save(attempt/'operation.json', {'source': str(source), 'phase': 'no_savings'})
            image.unlink(); metadata.unlink()
            return {'source': str(source), 'status': 'no_savings'}
        subprocess.run(['mount','-t','squashfs','-o','loop,ro,nodev,nosuid,noexec',str(image),str(stage)],check=True)
        try:
            proof = verify(source, stage, metadata)
            proof.update(source_root=str(source), image_sha256=digest(image), image_bytes=image.stat().st_size)
            save(verification, proof)
        finally:
            subprocess.run(['umount',str(stage)],check=True)

        def guard(visible, old):
            assert_idle(visible, old)
            assert_catalog(old or visible, metadata)
            if old:
                assert_namespaces(visible)

        save(attempt/'operation.json', {'source': str(source), 'phase': 'activating', 'verified': True})
        receipt = activate(source, image, metadata, verification, attempt/'activation', fstab, guard)
        save(attempt/'operation.json', {'source': str(source), 'phase': 'complete', 'receipt': receipt})
        return {'source': str(source), 'status': 'compressed', 'receipt': str(attempt/'activation/receipt.json'),
                'saved_bytes': proof['original_allocated_bytes']-image.stat().st_size-metadata.stat().st_size}
    except BaseException as error:
        # Never discard anything after activation began: source bindings, upper
        # writes and duplicate originals are all needed to recover safely.
        if not (attempt/'activation').exists() and not os.path.ismount(stage):
            shutil.rmtree(attempt)
        elif isinstance(error, Exception):
            raise RuntimeError('Retained archive and originals for safe recovery: '+str(attempt)) from error
        raise


def pending_operations(store):
    for attempt in store.iterdir() if store.exists() else []:
        if not attempt.is_dir() or not (attempt/'operation.json').is_file():
            continue
        operation = json.loads((attempt/'operation.json').read_text())
        if operation['phase'] in ('complete', 'no_savings'):
            continue
        receipt_path = attempt/'activation/receipt.json'
        if operation['phase'] == 'activating' and receipt_path.is_file():
            receipt = json.loads(receipt_path.read_text())
            source = Path(operation['source'])
            if (receipt.get('verified') and receipt.get('uncompressed_released')
                    and receipt.get('source') == str(source) and os.path.ismount(source)
                    and receipt.get('image') == str(attempt/'history.squashfs')
                    and digest(attempt/'history.squashfs') == receipt.get('image_sha256')):
                assert_namespaces(source)
                save(attempt/'operation.json', {**operation, 'phase': 'complete', 'receipt': receipt})
                continue
        if operation['phase'] == 'building' and not any(under(path, attempt) for path in mounts()):
            shutil.rmtree(attempt)  # Interrupted staging only; the source was never covered.
        else:
            raise RuntimeError('Retained unfinished archive for safe recovery: '+str(attempt))


def run(state=STATE, store=STORE, families=FAMILIES, now=None, apply=True):
    now = time.time() if now is None else now
    if apply:
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state/'run.lock').open('a') if apply else nullcontext() as lock:
        try:
            if lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'already_running'}
        if apply:
            pending_operations(store)
        disk = shutil.disk_usage(state if state.exists() else state.parent)
        reserve = max(RESERVE, int(disk.total*.05))
        if disk.free < reserve:
            raise RuntimeError('Free storage is below the safety reserve; originals retained')
        path = state/'observations.json'
        previous = json.loads(path.read_text()) if path.exists() else {}
        observations, results, errors = {}, [], []
        mounted = mounts()
        processed = False
        for source in candidates(families):
            name = str(source)
            try:
                current = observe(previous.get(name, {}), scan(source, mounted), now)
                assert_complete(source)
                observations[name] = current
                status = 'waiting_for_quiet_period'
                if ready(current, now):
                    status = 'ready'
                    if apply and not processed:
                        processed = True
                        result = compress(source, current, store)
                        current['no_savings'] = result['status'] == 'no_savings'
                        results.append(result)
                        continue
                results.append({'source': name, 'status': status})
            except Deferred as error:
                results.append({'source': name, 'status': 'deferred', 'reason': str(error)})
            except Exception as error:
                errors.append({'source': name, 'error': str(error)})
                break
        if apply:
            save(path, observations)
        result = {'schema': 1, 'status': 'failed' if errors else 'healthy', 'checked_at': now,
                  'results': results, 'errors': errors, 'reserve_bytes': reserve}
        if apply:
            save(state/'status.json', result)
        if errors:
            raise RuntimeError(json.dumps(result))
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only eligibility preview; do not advance the quiet period')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        print(json.dumps(run(apply=not args.check)), flush=True)
    except Exception as error:
        if not args.check:
            save(STATE/'status.json', {'schema': 1, 'status': 'failed', 'checked_at': time.time(), 'error': str(error)})
        raise


if __name__ == '__main__':
    main()
