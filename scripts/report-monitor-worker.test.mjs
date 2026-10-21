import test from 'node:test';
import assert from 'node:assert/strict';
import { reportWorker } from './report-monitor-worker.mjs';

test('the existing Hub report route forwards only a validated device binding and optional encrypted order',async()=>{
  const at=new Date().toISOString(),deviceId='610be10e-8a00-4e00-b000-000000000072';
  const report={schema:1,workerId:'mac-test',sampledAt:at,service:{running:true,lastPollAt:at},activity:{state:'idle',acceptingTasks:false,runs:[]}};
  const settings={serverURL:'https://monitor.example',teamId:'RSMACS01',ownerToken:'hub-only-test-token'};
  const response=body=>async()=>({ok:true,json:async()=>body});
  const result=await reportWorker(report,{settings,fetchImpl:response({ok:true,accepted:true,deviceId})});
  assert.deepEqual(result,{schema:1,accepted:true,deviceId});assert.ok(!JSON.stringify(result).includes(settings.ownerToken));
  await assert.rejects(()=>reportWorker(report,{settings,fetchImpl:response({ok:true,accepted:true,deviceId:'invalid'})}),/Geräte-Bestätigung/);
  const order={id:'opaque-order'};
  assert.deepEqual((await reportWorker(report,{settings,fetchImpl:response({ok:true,accepted:true,deviceId,accountCommand:order})})).accountCommand,order);
});
