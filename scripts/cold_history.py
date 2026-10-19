#!/usr/bin/env python3
"""Capture full file metadata and verify a mounted lossless cold-history image."""
import argparse
import base64
import errno
import gzip
import hashlib
import json
import os
from pathlib import Path
import stat
import time


def entries(root):
    pending = [Path('.')]
    while pending:
        relative = pending.pop()
        path = root / relative
        yield relative, path
        if path.is_dir() and not path.is_symlink():
            pending.extend(relative / child for child in sorted(os.listdir(path), reverse=True))


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4*1024*1024), b''):
            result.update(block)
    return result.hexdigest()


def attributes(path):
    # The production Linux runtime exposes these; Apple's system Python does
    # not. Local fixture tests have no extended attributes to preserve.
    if not hasattr(os, 'listxattr'):
        return {}
    try:
        keys = os.listxattr(path, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
            # A SquashFS with no xattr table reports ENOTSUP, not an empty list.
            # A source with attributes will still fail the equality check.
            return {}
        raise
    return {key: base64.b64encode(os.getxattr(path, key, follow_symlinks=False)).decode() for key in keys}


def capture(root, output):
    count = 0
    with output.open('xb') as file, gzip.GzipFile(fileobj=file, mode='wb', compresslevel=9, mtime=0) as packed:
        for relative, path in entries(root):
            value = path.lstat()
            row = {'path': str(relative), 'mode': value.st_mode, 'uid': value.st_uid, 'gid': value.st_gid,
                   'size': value.st_size, 'mtime_ns': value.st_mtime_ns, 'atime_ns': value.st_atime_ns,
                   'ctime_ns': value.st_ctime_ns, 'device': value.st_dev, 'inode': value.st_ino,
                   'blocks': value.st_blocks,
                   'xattrs': attributes(path)}
            if path.is_symlink():
                row['link'] = os.readlink(path)
            packed.write(json.dumps(row, sort_keys=True, separators=(',', ':')).encode()+b'\n')
            count += 1
    return {'entries': count, 'metadata_sha256': digest(output)}


def verify(root, mounted, metadata, progress=None):
    originals, copies = {}, {}
    files, count, logical, allocated = 0, 0, 0, 0
    with gzip.open(metadata, 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            relative = Path(row['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Unsafe history path')
            source, copy = root / relative, mounted / relative
            a, b = source.lstat(), copy.lstat()
            if (a.st_mode, a.st_uid, a.st_gid, a.st_size, a.st_mtime_ns, a.st_ino, a.st_dev) != \
                    (row['mode'], row['uid'], row['gid'], row['size'], row['mtime_ns'], row['inode'], row['device']):
                raise ValueError('Cold source changed: '+str(relative))
            if (a.st_mode, a.st_uid, a.st_gid, int(a.st_mtime)) != (b.st_mode, b.st_uid, b.st_gid, int(b.st_mtime)):
                raise ValueError('Image metadata differs: '+str(relative))
            attrs = attributes(copy)
            if attrs != row['xattrs']:
                raise ValueError('Image extended attributes differ: '+str(relative))
            if stat.S_ISREG(a.st_mode):
                if a.st_size != b.st_size:
                    raise ValueError('Image file size differs: '+str(relative))
                key, other = (a.st_dev, a.st_ino), (b.st_dev, b.st_ino)
                if key not in originals:
                    originals[key] = digest(source)
                    logical += a.st_size
                    allocated += a.st_blocks * 512
                if other not in copies:
                    copies[other] = digest(copy)
                if originals[key] != copies[other]:
                    raise ValueError('Image content differs: '+str(relative))
                files += 1
            elif stat.S_ISLNK(a.st_mode):
                if os.readlink(copy) != row['link']:
                    raise ValueError('Image symbolic link differs: '+str(relative))
            elif not stat.S_ISDIR(a.st_mode):
                if a.st_rdev != b.st_rdev:
                    raise ValueError('Image device differs: '+str(relative))
            count += 1
            if progress and count % 10000 == 0:
                progress({'checked_entries': count, 'checked_files': files,
                          'unique_source_bytes': logical, 'at': time.time()})
    if sum(1 for _ in entries(mounted)) != count:
        raise ValueError('Image has a different entry count')
    return {'verified': True, 'entries': count, 'files': files, 'unique_files': len(originals),
            'unique_source_bytes': logical, 'original_allocated_bytes': allocated,
            'metadata_sha256': digest(metadata)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('capture', 'verify'))
    parser.add_argument('--source', required=True)
    parser.add_argument('--metadata', required=True)
    parser.add_argument('--mounted')
    parser.add_argument('--receipt')
    parser.add_argument('--image', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    root, metadata = Path(args.source), Path(args.metadata)
    if args.command == 'capture':
        result = capture(root, metadata)
    else:
        if not args.mounted:
            parser.error('verify requires --mounted')
        result = verify(root, Path(args.mounted), metadata,
                        lambda value: print(json.dumps(value), flush=True))
    result['source_root'] = str(root.resolve())
    if args.image:
        result['image_sha256'] = digest(args.image)
        result['image_bytes'] = args.image.stat().st_size
    if args.receipt:
        with Path(args.receipt).open('x') as stream:
            json.dump(result, stream, sort_keys=True)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
