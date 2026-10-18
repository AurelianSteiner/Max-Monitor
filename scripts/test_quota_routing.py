import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from quota_routing import routing_inputs


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

    def test_missing_sources_are_unavailable_not_empty_capacity(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(routing_inputs(Path(folder))['available'])
