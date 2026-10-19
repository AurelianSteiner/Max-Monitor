import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib
from quota_usage import decode_packet, encode_packet, token_weight, validate_intervals
from quota_ledger import Ledger, iso
from quota_worker import read_chunk
from test_quota_tracker import NOW, RESET, payload, both_windows


class UsageTests(unittest.TestCase):
    def observed(self):
        return {'type': 'assistant', 'id': 'message-a', 'at': NOW + 100, 'model': 'claude-opus-5-5',
                'usage': {'input_tokens': 10, 'output_tokens': 100, 'cache_creation_input_tokens': 1000,
                          'cache_creation': {'ephemeral_5m_input_tokens': 0, 'ephemeral_1h_input_tokens': 1000},
                          'speed': 'standard', 'server_tool_use': {'web_search_requests': 2},
                          'iterations': [{'input_tokens': 10, 'output_tokens': 100}], 'secret': 'PRIVATE'},
                'tools': [{'id': 'tool-1', 'name': 'Bash', 'input_bytes': 40, 'input': 'PRIVATE'}]}

    def batch(self):
        p = payload()
        p['events'][1].update(model='claude-opus-5-5', cache_create=1000, cache_read=2000)
        p['usage_packet'] = encode_packet('mac-1', 'run-a', [self.observed(),
            {'type': 'tool_results', 'at': NOW + 120, 'results': [{'id': 'tool-1', 'result_bytes': 900, 'error': True}]}])
        return p

    def test_packet_checksum_and_bounded_decompression(self):
        packet = encode_packet('mac-1','r',[self.observed()])
        self.assertEqual(decode_packet(packet,'mac-1')['observations'][0],self.observed())
        with self.assertRaises(ValueError): decode_packet(packet,'other')
        with self.assertRaises(ValueError): decode_packet({**packet,'sha256':'bad'},'mac-1')
        oversized={**packet,'zlib_base64':base64.b64encode(zlib.compress(b'x'*(4*1024*1024+1))).decode()}
        with self.assertRaises(ValueError): decode_packet(oversized,'mac-1')

    def test_archive_retains_usage_variants_and_tools_without_content_and_deduplicates_replay(self):
        ledger=Ledger(':memory:');p=self.batch()
        ledger.ingest(p,NOW+650);ledger.ingest(p,NOW+650)
        self.assertEqual(ledger.db.execute('SELECT COUNT(*) FROM raw_archives').fetchone()[0],1)
        raw=zlib.decompress(ledger.db.execute('SELECT payload FROM raw_archives').fetchone()[0])
        self.assertNotIn(b'PRIVATE',raw)
        kept=json.loads(raw)['tables']['usage_packets'][0]['observations'][0]
        self.assertEqual(kept['usage']['iterations'],[{'input_tokens':10,'output_tokens':100}])
        self.assertEqual(kept['usage']['server_tool_use']['web_search_requests'],2)
        tool=dict(ledger.db.execute('SELECT * FROM tool_usage').fetchone())
        self.assertEqual((tool['input_bytes'],tool['result_bytes'],tool['error']),(40,900,1))
        p['usage_packet']=encode_packet('mac-1','run-a',[{**self.observed(),'usage':{**self.observed()['usage'],'output_tokens':120}}])
        ledger.ingest(p,NOW+650)
        self.assertEqual(ledger.db.execute('SELECT COUNT(*) FROM raw_archives').fetchone()[0],2)
        self.assertEqual(ledger.db.execute('SELECT COUNT(*) FROM tool_usage').fetchone()[0],1)

    def test_failed_archive_rolls_back_events_and_features_before_ack(self):
        ledger=Ledger(':memory:')
        with patch.object(ledger,'archive_rows',side_effect=ValueError('disk error')):
            with self.assertRaises(ValueError):ledger.ingest(self.batch(),NOW+650)
        for table in ('events','usage_features','tool_usage','runs'):
            self.assertEqual(ledger.db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)

    def test_weights_respect_model_cache_ttl_fast_mode_and_do_not_add_iterations(self):
        e={'model':'claude-opus-5-5','input_tokens':10,'output_tokens':100,'cache_create':1000,'cache_read':2000}
        feature={'cache_5m':0,'cache_1h':1000,'speed':'standard'}
        self.assertEqual(token_weight(e,feature),10440)
        self.assertEqual(token_weight(e,{**feature,'cache_5m':1000,'cache_1h':0}),7440)
        self.assertEqual(token_weight(e,{**feature,'speed':'fast'}),20880)
        self.assertIsNone(token_weight(e,{**feature,'cache_1h':999}))
        self.assertIsNone(token_weight({**e,'model':'future-model'},feature))
        self.assertIsNone(token_weight(e,None))

    def intervals(self, proxy_better=True):
        return [{'account':'a','window':'five_hour','reset':1,'begin':n*100,'end':(n+1)*100,
                 'delta':3,'turns':10 if n<6 else 20,'proxy':100 if proxy_better or n<6 else 200,'complete':True}
                for n in range(10)]

    def test_chronological_validation_selects_only_demonstrable_improvement(self):
        selected=validate_intervals(self.intervals())[('a','five_hour')]
        self.assertEqual(selected['method'],'token_proxy')
        self.assertEqual((selected['train_blocks'],selected['test_blocks']),(6,4))
        self.assertEqual(selected['metrics']['token_proxy']['mae_pp'],0)
        rs=self.intervals();rs[-1]['proxy']=10000
        self.assertEqual(validate_intervals(rs)[('a','five_hour')]['method'],'equal_turns')
        self.assertEqual(validate_intervals(self.intervals()[:7])[('a','five_hour')]['reason'],'insufficient_validation')

    def test_incomplete_intervals_and_reset_boundaries_do_not_form_training_blocks(self):
        rs=self.intervals()
        for r in rs:r['delta']=1;r['reset']=r['begin']
        self.assertEqual(validate_intervals(rs)[('a','five_hour')]['blocks'],0)
        for r in rs:r['reset']=1;r['complete']=False
        self.assertEqual(validate_intervals(rs)[('a','five_hour')]['method'],'equal_turns')

    def test_live_report_conserves_observed_deltas_and_publishes_token_and_tool_counts(self):
        ledger=Ledger(':memory:')
        ledger.fleet(both_windows(NOW,10),NOW)
        ledger.ingest(self.batch(),NOW+650)
        ledger.fleet(both_windows(NOW+700,12),NOW+700)
        report=ledger.report(1,NOW+701)
        j=report['jobs'][0]
        self.assertEqual(j['estimated_weekly_pp'],2)
        self.assertEqual(j['token_counts']['cache_create'],1000)
        self.assertEqual(j['tools'][0]['calls'],1)
        self.assertEqual(report['precision']['interval_methods']['equal_turns'],2)
        for total in report['account_deltas']:
            self.assertAlmostEqual(total['observed_pp'],total['estimated_assigned_pp']+total['unattributed_pp'])

    def test_weighted_allocation_and_incomplete_interval_fallback_preserve_whole_delta(self):
        ledger=Ledger(':memory:');ledger.fleet(both_windows(NOW,10),NOW)
        p=self.batch();p['runs'].append({**p['runs'][0],'run_id':'run-b','task_id':'task-b@1'})
        p['events'].append({**p['events'][0],'id':'quota-b','run_id':'run-b'})
        p['events'].append({**p['events'][1],'id':'message-b','run_id':'run-b','output_tokens':300})
        ledger.ingest(p,NOW+650)
        obs={**self.observed(),'id':'message-b'}
        ledger.ingest({'schema':1,'worker':'mac-1','usage_packet':encode_packet('mac-1','run-b',[obs])},NOW+650)
        ledger.fleet(both_windows(NOW+700,12),NOW+700)
        selected={('a@example.com',w):{'method':'token_proxy'} for w in ('five_hour','seven_day')}
        with patch('quota_ledger.validate_intervals',return_value=selected):
            report=ledger.report(1,NOW+701)
            a,b=sorted(report['jobs'],key=lambda j:j['job'])
            self.assertAlmostEqual(a['estimated_weekly_pp'],2*10440/(10440+14440))
            self.assertAlmostEqual(a['estimated_weekly_pp']+b['estimated_weekly_pp'],2)
            ledger.db.execute("DELETE FROM usage_features WHERE event_id='message-b'")
            ledger.db.commit()
            fallback=ledger.report(1,NOW+701)
        self.assertEqual([j['estimated_weekly_pp'] for j in fallback['jobs']],[1,1])

    def test_stream_evidence_deduplicates_variants_and_omits_inputs_and_results(self):
        msg={'type':'assistant','timestamp':iso(NOW+100),'message':{'id':'a','model':'claude-opus-5-5',
             'usage':self.observed()['usage'],'content':[{'type':'tool_use','id':'t','name':'Bash','input':{'command':'PRIVATE'}}]}}
        result={'type':'user','timestamp':iso(NOW+110),'message':{'content':[{'type':'tool_result','tool_use_id':'t','content':'PRIVATE'}]}}
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'stream.jsonl';path.write_text('\n'.join(json.dumps(e) for e in [msg,msg,result])+'\n')
            events,_,_,_=read_chunk(path)
        observations=next(e['observations'] for e in events if e['event_type']=='evidence')
        self.assertEqual(len(observations),2)
        self.assertNotIn('PRIVATE',json.dumps(events))
        self.assertGreater(observations[0]['tools'][0]['input_bytes'],0)

    def test_retention_archives_features_and_tools_before_pruning(self):
        ledger=Ledger(':memory:');ledger.fleet(both_windows(NOW,10),NOW)
        ledger.ingest(self.batch(),NOW+650);ledger.fleet(both_windows(NOW+700,12),NOW+700)
        ledger.dashboard(NOW+701)
        ledger.dashboard(NOW+49*3600)
        for table in ('usage_features','tool_usage'):
            self.assertEqual(ledger.db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)
        archives=[json.loads(zlib.decompress(r[0]))['tables'] for r in ledger.db.execute('SELECT payload FROM raw_archives')]
        self.assertTrue(any(a.get('usage_features') and a.get('tool_usage') for a in archives))


if __name__=='__main__':unittest.main()
