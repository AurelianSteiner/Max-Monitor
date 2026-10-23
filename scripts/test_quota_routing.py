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

IDENTITY = {'schema': 1, 'provider': 'anthropic', 'account': 'a' * 64, 'organization': 'b' * 64,
            'verifiedAt': '2026-10-21T10:00:00.000Z', 'source': 'oauth-profile'}
TYPED_SLOTS = copy.deepcopy(SLOTS)
TYPED_SLOTS[0].update(identity=IDENTITY, statusAt=SLOTS[0]['at'], blockedUntil=None)
TYPED_SLOTS[0]['runs'] = [{'kind': 'newsletter', 'started': None, 'id': 'ordinary:actual-a', 'identity': IDENTITY}]
TYPED_SLOTS[1].update(identity=None, statusAt=SLOTS[1]['at'])
TYPED_SLOTS[1]['runs'] = [{'kind': 'sales', 'started': None, 'identity': None}]


def typed_variant(change):
    value = copy.deepcopy(TYPED_SLOTS)
    change(value)
    return value


CASES += [
    ('typed provider and null unknown run', TYPED_SLOTS, True),
    ('typed explicit empty identity', typed_variant(lambda v: v[0].update(identity=None)), True),
    ('typed historic provider identity', typed_variant(lambda v: v[0]['identity'].update(verifiedAt='2025-10-21T10:00:00Z')), True),
    ('typed no account key', typed_variant(lambda v: v[0]['identity'].pop('account')), False),
    ('typed identity extra email', typed_variant(lambda v: v[0]['identity'].update(email='not-allowed')), False),
    ('typed identity array hash', typed_variant(lambda v: v[0]['identity'].update(account=['a' * 64])), False),
    ('typed identity array organization', typed_variant(lambda v: v[0]['identity'].update(organization=['b' * 64])), False),
    ('typed identity boolean schema', typed_variant(lambda v: v[0]['identity'].update(schema=True)), False),
    ('typed identity wrong provider', typed_variant(lambda v: v[0]['identity'].update(provider='unknown')), False),
    ('typed identity wrong source', typed_variant(lambda v: v[0]['identity'].update(source='manual-email')), False),
    ('typed identity invalid timestamp', typed_variant(lambda v: v[0]['identity'].update(verifiedAt='unknown')), False),
    ('typed identity short hash', typed_variant(lambda v: v[0]['identity'].update(account='a' * 16)), False),
    ('typed identity uppercase hash', typed_variant(lambda v: v[0]['identity'].update(account='A' * 64)), False),
    ('typed null status timestamp', typed_variant(lambda v: v[0].update(statusAt=None)), False),
    ('typed array status timestamp', typed_variant(lambda v: v[0].update(statusAt=[SLOTS[0]['at']])), False),
    ('typed boolean status timestamp', typed_variant(lambda v: v[0].update(statusAt=True)), False),
    ('typed invalid reset bound', typed_variant(lambda v: v[0].update(blockedUntil='unknown')), False),
    ('typed array run id', typed_variant(lambda v: v[0]['runs'][0].update(id=['ordinary:actual-a'])), False),
    ('typed wrong run prefix', typed_variant(lambda v: v[0]['runs'][0].update(id='synthetic:actual-a')), False),
    ('typed run id oversized', typed_variant(lambda v: v[0]['runs'][0].update(id='ordinary:' + 'a' * 300)), False),
    ('typed legacy null start without explicit unknown identity', variant(lambda v: v[0]['runs'][0].update(started=None)), False),
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

    @unittest.skipUnless(shutil.which('node') and PACING.is_file(), 'node or vendored quota-pacing.js missing')
    def test_actual_python_routing_retains_provider_scope_for_real_distribution(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Path(folder)
            fleet = hub / 'logs/ai-newsletter-fleet'
            fleet.mkdir(parents=True)
            for worker in ('a', 'b'):
                slots = copy.deepcopy(TYPED_SLOTS[:1])
                slots[0].update(status='ready', five_hour={'used': 60, 'reset': '2026-10-21T15:00:00Z'},
                                seven_day={'used': 20, 'reset': '2026-10-24T08:00:00Z'})
                slots[0]['runs'][0]['id'] = 'ordinary:actual-' + worker
                (fleet / (worker + '.json')).write_text(json.dumps({'worker_id': worker, 'seen_at': SLOTS[0]['at'],
                    'annahme': True, 'max_tasks': 3, 'occupied_tasks': 1,
                    'plaetze': {'newsletter': 3, 'klaviyo': 3, 'translation': 3, 'korrektur': 3}, 'quota_slots': slots}))
            register = hub / 'state/worker-reservations'
            register.mkdir(parents=True)
            (register / 'enabled').touch()
            db = sqlite3.connect(register / 'claims.sqlite')
            db.execute('CREATE TABLE reservations(doc TEXT)')
            db.commit()
            db.close()
            routing = routing_inputs(hub)
            self.assertTrue(routing['available'])
            self.assertEqual(len(routing['fleet']), 2)
            self.assertTrue(all('quota_slots' in worker for worker in routing['fleet']))
            script = ('const {distribution}=require(process.argv[1]);let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{'
                      'const routing=JSON.parse(s),at="2026-10-21T10:00:00Z";'
                      'const value=distribution({scheduling:{schema:1,generated_at:at,routing}},'
                      'routing.fleet.map(w=>({workerId:w.worker_id})),Date.parse(at));'
                      'process.stdout.write(JSON.stringify(value.by_kind.newsletter.rows));});')
            rows = json.loads(subprocess.run(['node', '-e', script, str(PACING.parent / 'distribution.js')],
                input=json.dumps(routing), capture_output=True, text=True, check=True, timeout=30).stdout)
            self.assertEqual([row['reason'] for row in rows], ['guard_5h', 'guard_5h'])
            self.assertEqual([row['windows']['five_hour']['remaining'] for row in rows], [40, 40])
