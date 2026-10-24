import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readHubFigmaImports,buildFigmaImportQueue,parseRegisterClaim,collectSnapshot} from './newsletter-monitor-bridge.mjs';
const vector=JSON.parse(fs.readFileSync(new URL('../team-server/test/fixtures/mail-import-candidate.json',import.meta.url)));
const now=Date.parse('2026-10-07T12:00:00Z'),copy=value=>structuredClone(value);
function claim(changes={}){return parseRegisterClaim({taskId:vector.candidate.taskId,jobKind:'figma-import',candidateHash:vector.candidate.candidateHash,writeScope:'test',runId:'real-import-run',worker:'macbook-1',state:'running',heartbeat:now/1000,ts:String(now/1000)+'.000001',...changes});}
test('actual Hub candidate vector uses its ordinary reservation without inventing a ClickUp order',()=>{
 const intent=copy(vector.intent),c=claim();assert.ok(c);
 const waiting=buildFigmaImportQueue([intent],[],{now})[0];assert.equal(waiting.status,'queued');assert.equal(waiting.url,undefined);assert.equal(waiting.workerId,undefined);
 const active=buildFigmaImportQueue([intent],[c],{now})[0];assert.equal(active.status,'running');assert.equal(active.workerId,'macbook-1');assert.equal(active.attemptId,'real-import-run');assert.equal(active.figmaUrl,undefined);
 assert.equal(buildFigmaImportQueue([intent],[claim({candidateHash:'f'.repeat(64)})],{now})[0].status,'queued');
 assert.equal(buildFigmaImportQueue([intent],[claim({writeScope:'foreign'})],{now})[0].workerId,undefined);
 assert.equal(claim({jobKind:'newsletter'}),null);
 assert.equal(buildFigmaImportQueue([intent],[claim({paused:true,portable:true})],{now})[0].status,'queued');
});
test('completed import history requires exact original source and the real verified target receipt',()=>{
 const intent=copy(vector.intent);intent.status='completed';intent.admission={physicalWorkerId:'macbook-1',runId:'real-import-run'};
 intent.result={sourceRef:copy(intent.sourceRef),target:{url:'https://www.figma.com/design/TESTFILE123?node-id=1-2'},metadataVerified:true,footerVerified:true,editableTextNodes:2,frameSha256:'c'.repeat(64)};
 const row=buildFigmaImportQueue([intent],[],{now})[0];assert.equal(row.status,'completed');assert.equal(row.figmaUrl,intent.result.target.url);assert.match(row.mailUrl,/version=2$/);
 intent.result.sourceRef.version=3;assert.throws(()=>buildFigmaImportQueue([intent],[],{now}),/Zielbezug/);
});
test('actual read-only SQLite reader preserves source bytes and handles older Hub schemas',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-import-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));
 const file=path.join(root,'data/customer-intelligence.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE legacy(id TEXT)');db.close();assert.deepEqual(readHubFigmaImports(root,{now}),[]);
 const next=new DatabaseSync(file);next.exec('CREATE TABLE mail_package_figma_imports(customer_id,mail_id,intent_id,request_hash,source_ref,target_file_key,status,admission,result,error,created_at,updated_at)');
 const i=vector.intent;next.prepare('INSERT INTO mail_package_figma_imports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(i.customerId,i.mailId,i.intentId,i.requestHash,JSON.stringify(i.sourceRef),i.targetFileKey,i.status,null,null,null,i.createdAt,i.updatedAt);next.close();
 const before=fs.readFileSync(file),items=readHubFigmaImports(root,{now});assert.equal(items.length,1);assert.equal(buildFigmaImportQueue(items,[claim()],{now})[0].status,'running');assert.ok(fs.readFileSync(file).equals(before));
});
test('ordinary complete snapshot includes durable PM imports and retains cache on import-source failure',async()=>{
 const options={now,config:{clickup:{workspace_id:'test'},slack:{channel_id:'test'},hub:{}},fleetReader:async()=>[],hubFetch:async target=>({ok:true,status:200,json:async()=>String(target).includes('slack.com')?{ok:true,messages:[],has_more:false}:{spaces:[],tasks:[]}}),figmaImportReader:async()=>[copy(vector.intent)]};
 const snapshot=await collectSnapshot(options);assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.tasks[0].workflow,'figma-import');assert.equal(snapshot.tasks[0].status,'queued');
 const failed=await collectSnapshot({...options,figmaImportReader:async()=>{throw Error('PM import source unavailable');}});assert.equal(failed.tasks,undefined);assert.match(failed.source.error,/PM import/);
});
