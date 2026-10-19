#!/usr/bin/env python3
"""Verify or export every retained raw quota row without changing the live ledger."""
import argparse
import hashlib
import json
import lzma
import os
from pathlib import Path
import sqlite3
import zlib


def records(db):
    for row in db.execute("SELECT id,raw_bytes,payload FROM raw_archives ORDER BY archived_at,id"):
        raw = zlib.decompress(row[2])
        if len(raw) != row[1] or hashlib.sha256(raw).hexdigest() != row[0]:
            raise ValueError("Raw quota archive checksum mismatch")
        yield raw


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("verify", "export"))
    parser.add_argument("--db", default="/var/lib/max-monitor-quota/ledger.sqlite")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.command == "export" and not args.output:
        parser.error("export requires --output <new-file.jsonl.xz>")
    db = sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True)
    count = 0
    try:
        if args.command == "export":
            # Exclusive creation protects existing archives; all original columns
            # and values remain in each lossless JSON record.
            with Path(args.output).open("xb") as file, lzma.open(file, "wt", preset=6) as output:
                for raw in records(db):
                    output.write(raw.decode() + "\n")
                    count += 1
        else:
            for _ in records(db):
                count += 1
    finally:
        db.close()
    print(json.dumps({"ok": True, "verified_batches": count}))


if __name__ == "__main__":
    main()
