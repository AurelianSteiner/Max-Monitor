#!/usr/bin/env python3
"""Activate already verified cold history without changing any visible file path."""
import argparse
import base64
import fcntl
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from cold_history import digest, attributes


def activate(source, image, metadata, verification, work, fstab=Path('/etc/fstab'), guard=None):
    with Path('/run/lock/max-monitor-cold-history.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _activate(source, image, metadata, verification, work, fstab, guard)


def _activate(source, image, metadata, verification, work, fstab, guard=None):
    if source.is_symlink() or image.is_symlink():
        raise ValueError('Symlink mount sources are not allowed')
    source, image, work = source.resolve(), image.resolve(), work.resolve()
    proof = json.loads(verification.read_text())
    if not proof.get('verified') or proof['metadata_sha256'] != digest(metadata) or proof.get('source_root') != str(source):
        raise ValueError('Complete verification receipt required')
    if str(source) in ('/', '/opt', '/opt/rs-hub', '/var', '/var/lib'):
        raise ValueError('Only a closed historical leaf may be mounted')
    if any(c.isspace() for c in str(source)+str(image)) or source.is_symlink():
        raise ValueError('Unsafe mount path')
    if subprocess.run(['mountpoint', '-q', str(source)]).returncode == 0:
        raise ValueError('Source is already mounted; inspect existing receipt')
    old_fstab = fstab.read_bytes()
    if any(line.split()[1:2] == [str(source)] for line in old_fstab.decode().splitlines() if not line.lstrip().startswith('#')):
        raise ValueError('An existing fstab entry owns this mount')
    def image_identity():
        s = image.stat()
        return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

    identity = image_identity()
    image_sha = digest(image)
    if proof.get('image_sha256') != image_sha:
        raise ValueError('The image differs from its full verification receipt')
    if image_identity() != identity:
        raise ValueError('Image changed during verification')
    # Recheck the entire immutable source immediately before covering it.
    with gzip.open(metadata, 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            relative = Path(row['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Unsafe metadata path')
            current = (source / relative).lstat()
            if (current.st_mode, current.st_uid, current.st_gid, current.st_size, current.st_mtime_ns, current.st_ino, current.st_dev) != \
                    (row['mode'], row['uid'], row['gid'], row['size'], row['mtime_ns'], row['inode'], row['device']):
                raise ValueError('Source changed after verification: '+str(relative))
    with image.open('rb') as stream:
        os.fsync(stream.fileno())
    directory = os.open(str(image.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    if guard:
        guard(source, None)
    work.mkdir(mode=0o700, parents=True, exist_ok=False)
    old = work/'original'
    old.mkdir(mode=0o700)
    lower, upper, overlay_work = work/'lower', work/'upper', work/'overlay-work'
    lower.mkdir(mode=0o700)
    original_stat = source.stat()
    upper.mkdir(mode=original_stat.st_mode & 0o7777)
    os.chown(upper, original_stat.st_uid, original_stat.st_gid)
    os.chmod(upper, original_stat.st_mode & 0o7777)
    for key, value in attributes(source).items():
        os.setxattr(upper, key, base64.b64decode(value))
    os.utime(upper, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    overlay_work.mkdir(mode=0o700)
    (work/'fstab-before').write_bytes(old_fstab)
    subprocess.run(['mount', '--bind', str(source), str(old)], check=True)
    # Ubuntu's root mount is shared. Without a private bind, the image overlay
    # can propagate into the backing alias and hide the originals there too.
    subprocess.run(['mount', '--make-private', str(old)], check=True)
    mounted = False
    lower_mounted = False
    configured = False
    try:
        # Mounting covers the old directory atomically. Existing readers keep
        # their old descriptors; new opens use the verified image immediately.
        subprocess.run(['mount', '-t', 'squashfs', '-o', 'loop,ro,nodev,nosuid,noexec', str(image), str(lower)], check=True)
        lower_mounted = True
        overlay_options = 'lowerdir='+str(lower)+',upperdir='+str(upper)+',workdir='+str(overlay_work)+',nodev,nosuid,noexec'
        if fstab.read_bytes() != old_fstab or image_identity() != identity:
            raise ValueError('Activation source drift')
        line = ('\n# Lossless cold history; full metadata and proof: '+str(work)+'\n'
                +str(image)+' '+str(lower)+' squashfs loop,ro,nodev,nosuid,noexec 0 0\n'
                +'overlay '+str(source)+' overlay '+overlay_options+',x-systemd.requires-mounts-for='+str(lower)+' 0 0\n')
        temporary = fstab.with_name(fstab.name+'.cold-history.tmp')
        with temporary.open('wb') as stream:
            stream.write(old_fstab+line.encode());stream.flush();os.fsync(stream.fileno())
        temporary.chmod(0o644);temporary.replace(fstab)
        configured = True
        directory = os.open(str(fstab.parent), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        # Persist BEFORE publishing. A crash after the atomic mount must keep
        # subsequent overlay writes visible after reboot as well.
        subprocess.run(['mount', '-t', 'overlay', 'overlay', '-o', overlay_options, str(source)], check=True)
        mounted = True
        filesystem = subprocess.check_output(['findmnt', '-n', '-o', 'FSTYPE', '--target', str(source)], text=True).strip()
        if filesystem != 'overlay':
            raise ValueError('Compressed history is not mounted')
        if str(source).startswith(('/opt/rs-hub/', '/var/lib/rs-hub-recovery-')):
            for service in ('rs-hub.service', 'max-monitor-queue.service', 'max-monitor-relay.service'):
                pid = subprocess.check_output(['systemctl','show',service,'-p','MainPID','--value'],text=True).strip()
                if pid and pid != '0':
                    view = subprocess.check_output(['nsenter','--target',pid,'--mount','--','findmnt','-n','-o','FSTYPE','--target',str(source)],text=True).strip()
                    if view != 'overlay':
                        raise ValueError('Existing service cannot see the compressed history: '+service)
        receipt = {**proof, 'source': str(source), 'image': str(image), 'image_sha256': image_sha,
                   'image_bytes': image.stat().st_size, 'mounted_at': time.time(),
                   'complete_metadata': str(metadata), 'uncompressed_released': False,
                   'lower': str(lower), 'upper': str(upper), 'writable_sidecars_preserved': True}
        (work/'receipt.json').write_text(json.dumps(receipt, sort_keys=True))
    except BaseException:
        if mounted:
            # New opens may already have written into upper. Keep both layers,
            # the persistent configuration and the private original bind.
            raise
        if lower_mounted:
            subprocess.run(['umount', str(lower)], check=True)
        if configured:
            fstab.write_bytes(old_fstab)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['umount', str(old)], check=True)
        raise
    # Bytes are fully verified, durable and mounted at the original paths.
    # Remove only the duplicate backing entries through our private bind alias.
    # A failed final guard deliberately retains BOTH the mounted image and the
    # original bind alias. Rolling back here could hide new overlay writes.
    if guard:
        guard(source, old)
    for child in old.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    subprocess.run(['umount', str(old)], check=True)
    old.rmdir()
    receipt['uncompressed_released'] = True
    receipt['finished_at'] = time.time()
    (work/'receipt.json').write_text(json.dumps(receipt, sort_keys=True))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'image', 'metadata', 'verification', 'work'):
        parser.add_argument('--'+name, required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    result = activate(args.source, args.image, args.metadata, args.verification, args.work)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
