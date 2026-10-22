import copy
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from quota_routing import routing_inputs, valid_quota_slots

PACING = Path(__file__).resolve().parent.parent / 'team-server/quota-pacing.js'
SLOTS = [{'slot': 'primary', 'status': 'ready', 'at': '2026-10-21T10:00:00.000Z',
          'five_hour': {'used': 12.5, 'reset': '2026-10-21T13:00:00.000Z'},
          'seven_day': {'used': 40, 'reset': '2026-10-24T08:00:00.000Z'},
          'runs': [{'kind': 'newsletter', 'started': '2026-10-21T09:30:00.000Z'}]},
         {'slot': 'account-2', 'status': 'limited', 'at': '2026-10-21T09:59:00Z',
          'five_hour': {'used': 0, 'reset': None}, 'seven_day': {'used': 100, 'reset': '2026-10-23T08:00:00+02:00'},
          'runs': []}]


def variant(change):
    value = copy.deepcopy(SLOTS)
    change(value)
    return value


# (name, value, expected); "stricter" values pass Date.parse but not the strict ISO form.
CASES = [
    ('valid pair', SLOTS, True),
    ('valid single', [dict(SLOTS[0], slot='single')], True),
    ('twelve runs', variant(lambda v: v[0].update(runs=v[0]['runs'] * 12)), True),
    ('empty list', [], False),
    ('three slots', SLOTS + [dict(SLOTS[0], slot='single')], False),
    ('duplicate slot', variant(lambda v: v[1].update(slot='primary')), False),
    ('unknown slot', variant(lambda v: v[0].update(slot='account-3')), False),
    ('unknown status', variant(lambda v: v[0].update(status='busy')), False),
    ('extra slot key', variant(lambda v: v[0].update(token='secret')), False),
    ('missing runs', variant(lambda v: v[0].pop('runs')), False),
    ('used above 100', variant(lambda v: v[0]['five_hour'].update(used=100.5)), False),
    ('negative used', variant(lambda v: v[0]['seven_day'].update(used=-1)), False),
    ('boolean used', variant(lambda v: v[0]['five_hour'].update(used=True)), False),
    ('string used', variant(lambda v: v[0]['five_hour'].update(used='12')), False),
    ('weekly reset null', variant(lambda v: v[0]['seven_day'].update(reset=None)), False),
    ('extra window key', variant(lambda v: v[0]['five_hour'].update(at='2026-10-21T10:00:00Z')), False),
    ('null window', variant(lambda v: v[0].update(five_hour=None)), False),
    ('thirteen runs', variant(lambda v: v[0].update(runs=v[0]['runs'] * 13)), False),
    ('unknown run kind', variant(lambda v: v[0]['runs'][0].update(kind='korrektur')), False),
    ('extra run key', variant(lambda v: v[0]['runs'][0].update(task='private')), False),
    ('run not object', variant(lambda v: v[0].update(runs=['newsletter'])), False),
    ('slot not object', [SLOTS[0], 'primary'], False),
    ('not a list', {'slot': 'primary'}, False),
    ('time too long', variant(lambda v: v[0].update(at='2026-10-21T10:00:00.000000000000000000000000000Z')), False),
    ('time not text', variant(lambda v: v[0].update(at=1792576800000)), False),
    ('garbage time', variant(lambda v: v[0].update(at='soon')), False),
    ('bare number time', variant(lambda v: v[0].update(at='1')), 'stricter'),
    ('date only', variant(lambda v: v[0].update(at='2026-10-21')), 'stricter'),
    ('impossible date', variant(lambda v: v[0].update(at='2026-02-30T10:00:00Z')), 'stricter'),
    ('non-ascii digits', variant(lambda v: v[0].update(at='\u0662026-10-21T10:00:00Z')), False),
]


class RoutingTest(unittest.TestCase):
    def test_exact_readonly_sources_omit_content_and_paused_or_finished_jobs(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Path(folder)
            fleet = hub / 'logs/ai-newsletter-fleet'
            fleet.mkdir(parents=True)
            (fleet / 'a.json').write_text(json.dumps({'worker_id': 'macbook-1', 'seen_at': '2026-10-18T22:00:00Z', 'annahme': True, 'secret': 'omitted'}))
            register = hub / 'state/worker-reservations'
            register.mkdir(parents=True)
            (register / 'enabled').touch()
            db = sqlite3.connect(register / 'claims.sqlite')
            db.execute('CREATE TABLE reservations(doc TEXT)')
            for task, state, paused in [('abc-klaviyo', 'running', False), ('abc-uebersetzung-en', 'claiming', False), ('korrektur-123', 'running', False), ('done', 'done', False), ('paused', 'running', True)]:
                db.execute('INSERT INTO reservations VALUES(?)', (json.dumps({'worker': 'macbook-1', 'taskId': task, 'state': state, 'paused': paused, 'text': 'private content'}),))
            db.commit()
            result = routing_inputs(hub)
            self.assertTrue(result['available'])
            self.assertEqual([j['kind'] for j in result['jobs']], ['upload', 'translation', 'correction'])
            self.assertNotIn('private', json.dumps(result))
            self.assertNotIn('secret', json.dumps(result))
            self.assertEqual(db.execute('SELECT count(*) FROM reservations').fetchone()[0], 5)
            db.close()

    def test_valid_quota_slots_are_forwarded_and_invalid_ones_dropped_without_the_heartbeat(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Path(folder)
            fleet = hub / 'logs/ai-newsletter-fleet'
            fleet.mkdir(parents=True)
            base = {'seen_at': '2026-10-21T10:00:00Z', 'annahme': True, 'occupied_tasks': 1, 'max_tasks': 3}
            (fleet / 'a.json').write_text(json.dumps({**base, 'worker_id': 'mac-a', 'quota_slots': SLOTS}))
            (fleet / 'b.json').write_text(json.dumps({**base, 'worker_id': 'mac-b', 'quota_slots': CASES[5][1]}))
            (fleet / 'c.json').write_text(json.dumps({**base, 'worker_id': 'mac-c', 'quota_slots': 'n/a'}))
            (fleet / 'd.json').write_text(json.dumps({**base, 'worker_id': 'mac-d', 'quota_slots': SLOTS, 'pad': 'x' * 65536}))
            (fleet / 'e.json').write_text(json.dumps([{'worker_id': 'mac-e'}]))
            result = {entry['worker_id']: entry for entry in routing_inputs(hub)['fleet']}
            self.assertEqual(sorted(result), ['mac-a', 'mac-b', 'mac-c'], 'oversized or non-object heartbeats are skipped')
            self.assertEqual(result['mac-a']['quota_slots'], SLOTS)
            for worker in ('mac-b', 'mac-c'):
                self.assertNotIn('quota_slots', result[worker])
                self.assertEqual(result[worker]['occupied_tasks'], 1)

    def test_quota_slot_validator_matches_the_worker_shape(self):
        for name, value, expected in CASES:
            with self.subTest(name):
                self.assertIs(valid_quota_slots(value), expected is True)

    @unittest.skipUnless(shutil.which('node') and PACING.is_file(), 'node or vendored quota-pacing.js missing')
    def test_python_validator_never_accepts_what_the_worker_rejects(self):
        script = ('const {validQuotaSlots}=require(process.argv[1]);let input="";process.stdin.on("data",c=>input+=c);'
                  'process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(input).map(validQuotaSlots))));')
        verdicts = json.loads(subprocess.run(['node', '-e', script, str(PACING)], input=json.dumps([c[1] for c in CASES]),
                                             capture_output=True, text=True, check=True, timeout=30).stdout)
        for (name, value, expected), worker in zip(CASES, verdicts):
            with self.subTest(name):
                self.assertIs(worker, expected is not False, 'worker verdict')
                if valid_quota_slots(value):
                    self.assertTrue(worker)

    def test_missing_sources_are_unavailable_not_empty_capacity(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(routing_inputs(Path(folder))['available'])
