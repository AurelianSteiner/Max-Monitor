import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';
import{ensureQuotaObserver}from'./install-quota-observer.mjs';
test('Codex repair workers never install a Claude quota observer',async()=>{
 const result=await ensureQuotaObserver({workerRoot:'/production'},{platform:'darwin',
  loadConfig:()=>({worker_id:'hausdraches-macbook-air-f1e2b4ad',clickup:{transport:'rs_hub'}}),
  runner:()=>assert.fail('Codex must not inspect or start Claude quota launchd')});
 assert.deepEqual(result,{installed:false});
});
test('new workers acquire the quota collector; repeated setup leaves both production and the healthy observer running',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'quota-install-')),calls=[];let loaded=false;
 const dependencies={home,platform:'darwin',uid:501,loadConfig:()=>({worker_id:'pink',clickup:{transport:'rs_hub'}}),runner:async(bin,args)=>{calls.push([bin,args]);if(bin==='/bin/launchctl'&&!loaded)throw Error('not loaded');if(bin==='/usr/bin/python3')loaded=true;return'';}};
 try{
  const first=await ensureQuotaObserver({workerRoot:'/production'},dependencies);assert.equal(first.changed,true);const starts=calls.filter(([bin])=>bin==='/usr/bin/python3').length;
  const second=await ensureQuotaObserver({workerRoot:'/production'},dependencies);assert.equal(second.changed,false);assert.equal(calls.filter(([bin])=>bin==='/usr/bin/python3').length,starts);
  assert.equal(calls.some(([,args])=>args.some(a=>String(a).includes('ai-newsletter.plist'))),false);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
