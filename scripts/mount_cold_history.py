#!/usr/bin/env python3
"""Activate already verified cold history without changing any visible file path."""
import argparse
import fcntl
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from cold_history import digest


def activate(source, image, metadata, verification, work, fstab=Path('/etc/fstab')):
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
    image_sha = digest(image)
    if proof.get('image_sha256') != image_sha:
        raise ValueError('The image differs from its full verification receipt')
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
    work.mkdir(mode=0o700, parents=True, exist_ok=False)
    old = work/'original'
    old.mkdir(mode=0o700)
    (work/'fstab-before').write_bytes(old_fstab)
    subprocess.run(['mount', '--bind', str(source), str(old)], check=True)
    # Ubuntu's root mount is shared. Without a private bind, the image overlay
    # can propagate into the backing alias and hide the originals there too.
    subprocess.run(['mount', '--make-private', str(old)], check=True)
    mounted = False
    configured = False
    try:
        # Mounting covers the old directory atomically. Existing readers keep
        # their old descriptors; new opens use the verified image immediately.
        subprocess.run(['mount', '-t', 'squashfs', '-o', 'loop,ro,nodev,nosuid,noexec', str(image), str(source)], check=True)
        mounted = True
        if fstab.read_bytes() != old_fstab or digest(image) != image_sha:
            raise ValueError('Activation source drift')
        line = '\n# Lossless cold history; full metadata and proof: '+str(work)+'\n'+str(image)+' '+str(source)+' squashfs loop,ro,nodev,nosuid,noexec 0 0\n'
        temporary = fstab.with_name(fstab.name+'.cold-history.tmp')
        with temporary.open('wb') as stream:
            stream.write(old_fstab+line.encode());stream.flush();os.fsync(stream.fileno())
        temporary.chmod(0o644);temporary.replace(fstab)
        configured = True
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        filesystem = subprocess.check_output(['findmnt', '-n', '-o', 'FSTYPE', '--target', str(source)], text=True).strip()
        if filesystem != 'squashfs':
            raise ValueError('Compressed history is not mounted')
        receipt = {**proof, 'source': str(source), 'image': str(image), 'image_sha256': image_sha,
                   'image_bytes': image.stat().st_size, 'mounted_at': time.time(),
                   'complete_metadata': str(metadata), 'uncompressed_released': False}
        (work/'receipt.json').write_text(json.dumps(receipt, sort_keys=True))
    except BaseException:
        if mounted:
            subprocess.run(['umount', str(source)], check=True)
        if configured:
            fstab.write_bytes(old_fstab)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['umount', str(old)], check=True)
        raise
    # Bytes are fully verified, durable and mounted at the original paths.
    # Remove only the duplicate backing entries through our private bind alias.
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
    with Path('/run/lock/max-monitor-cold-history.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = activate(args.source, args.image, args.metadata, args.verification, args.work)
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
