"""Content-free usage evidence and conservative, empirically gated allocation.

API prices supply relative weights only. Observed subscription deltas remain the
only source of percentage points; tool/iteration tokens must never be added twice.
"""
import base64
from collections import defaultdict
import hashlib
import json
import math
import re
import zlib

VERSION = "usage-v1-2026-10-19"
MAX_PACKET = 4 * 1024 * 1024
PRICE_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing"
# Input, output, 5-minute write, 1-hour write, cache read USD / million tokens.
PRICES = {"claude-opus-5-5": (4, 20, 5, 8, .2),
          "claude-sonnet-5-5": (2, 10, 2.5, 4, .1),
          "claude-haiku-4-5-20251001": (1, 5, 1.25, 2, .1)}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def usage_metadata(value, depth=0):
    """Preserve provider numeric metadata, excluding arbitrary content strings."""
    if depth > 8:
        raise ValueError("Usage metadata nesting exceeds limit")
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", key):
                continue
            if isinstance(item, str):
                if key in ("service_tier", "inference_geo", "speed", "type") and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", item):
                    result[key] = item
            elif item is None or isinstance(item, bool) or isinstance(item, (int, float)) and math.isfinite(item):
                result[key] = item
            elif isinstance(item, (dict, list)):
                result[key] = usage_metadata(item, depth + 1)
        return result
    if isinstance(value, list):
        return [usage_metadata(item, depth + 1) for item in value if isinstance(item, (dict, list))]
    return {}


def encode_packet(worker, run_id, observations):
    raw = canonical({"schema": 1, "worker": worker, "run_id": run_id, "observations": observations})
    if len(raw) > MAX_PACKET:
        raise ValueError("Usage evidence packet exceeds limit")
    return {"sha256": hashlib.sha256(raw).hexdigest(), "raw_bytes": len(raw),
            "zlib_base64": base64.b64encode(zlib.compress(raw, 9)).decode()}


def decode_packet(packet, worker):
    decoder = zlib.decompressobj()
    payload = base64.b64decode(packet["zlib_base64"], validate=True)
    raw = decoder.decompress(payload, MAX_PACKET + 1)
    if len(raw) > MAX_PACKET or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("Invalid or oversized usage evidence packet")
    if len(raw) != packet["raw_bytes"] or hashlib.sha256(raw).hexdigest() != packet["sha256"]:
        raise ValueError("Usage evidence checksum mismatch")
    value = json.loads(raw)
    if value.get("schema") != 1 or value.get("worker") != worker or not isinstance(value.get("observations"), list):
        raise ValueError("Usage evidence identity mismatch")
    return value


def token_weight(event, feature=None):
    """None means unsupported/incomplete, zero is verified synthetic usage only."""
    tokens = [event[k] for k in ("input_tokens", "output_tokens", "cache_create", "cache_read")]
    if event["model"] == "<synthetic>" and not any(tokens):
        return 0.0
    prices = PRICES.get(event["model"])
    if not prices or feature is None or feature["speed"] not in ("standard", "fast"):
        return None
    if feature["cache_5m"] + feature["cache_1h"] != tokens[2]:
        return None  # Cache TTL is measured, never inferred from the plan.
    if feature["speed"] == "fast" and event["model"] != "claude-opus-5-5":
        return None
    amounts = (tokens[0], tokens[1], feature["cache_5m"], feature["cache_1h"], tokens[3])
    return sum(n * p for n, p in zip(amounts, prices)) * (2 if feature["speed"] == "fast" else 1)


def validate_intervals(intervals):
    """Chronological 60/40 holdout per account/window; no heavy ML dependency.

    Group >=3pp across contiguous intervals to reduce integer censoring. Require
    >=8 blocks, >=4 calibration and >=4 holdout blocks, 10% MAE and 5% RMSE gain.
    Percentage scale is fitted only on calibration blocks and cancels in shares.
    """
    grouped = defaultdict(list)
    for item in intervals:
        grouped[(item['account'], item['window'])].append(item)
    results = {}
    for key, rows in grouped.items():
        blocks, pending = [], []
        for item in sorted(rows, key=lambda r: r['end']):
            if not item['complete']:
                pending = []
                continue
            if pending and (item['reset'] != pending[-1]['reset'] or item['begin'] > pending[-1]['end'] + 1):
                pending = []
            pending.append(item)
            if sum(r['delta'] for r in pending) >= 3:
                blocks.append({'delta': sum(r['delta'] for r in pending),
                               'turns': sum(r['turns'] for r in pending),
                               'proxy': sum(r['proxy'] for r in pending)})
                pending = []
        split = max(4, int(len(blocks) * .6))
        result = {'method': 'equal_turns', 'blocks': len(blocks), 'train_blocks': min(split, len(blocks)),
                  'test_blocks': max(0, len(blocks) - split), 'reason': 'insufficient_validation'}
        if len(blocks) >= 8 and len(blocks) - split >= 4:
            train, test = blocks[:split], blocks[split:]
            metrics = {}
            for method, field in (('equal_turns', 'turns'), ('token_proxy', 'proxy')):
                scale = sum(b['delta'] for b in train) / sum(b[field] for b in train)
                errors = [scale * b[field] - b['delta'] for b in test]
                metrics[method] = {'mae_pp': sum(abs(e) for e in errors) / len(errors),
                                   'rmse_pp': math.sqrt(sum(e * e for e in errors) / len(errors))}
            gain = metrics['token_proxy']['mae_pp'] <= .9 * metrics['equal_turns']['mae_pp']
            stable = metrics['token_proxy']['rmse_pp'] <= .95 * metrics['equal_turns']['rmse_pp']
            result.update(metrics=metrics, reason='heldout_improvement' if gain and stable else 'no_clear_improvement',
                          method='token_proxy' if gain and stable else 'equal_turns')
        results[key] = result
    return results
