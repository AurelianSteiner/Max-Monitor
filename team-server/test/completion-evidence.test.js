const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFleetStore}=require('../fleet');
test('completion evidence survives relay storage and snapshot while missing dates remain unknown',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'completion-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createFleetStore(dir,()=>Date.parse('2026-10-14T17:00:00Z'));
 const task={id:'clickup:newsletter:a',title:'Flow',workflow:'newsletter',contentKind:'flow',status:'completed',completedAt:'2026-10-12T12:00:00Z',completionSource:'slack',updatedAt:'2026-10-14T12:00:00Z'};
 store.updateQueue('TESTTEAM',{source:{name:'test'},tasks:[task,{...task,id:'unknown',completedAt:undefined,completionSource:'clickup'}]});
 const rows=store.snapshot('TESTTEAM').queue.tasks;
 assert.equal(rows[0].completedAt,'2026-10-12T12:00:00.000Z');
 assert.equal(rows[0].contentKind,'flow');assert.equal(rows[0].completionSource,'slack');
 assert.equal(rows[1].completedAt,undefined);
});
