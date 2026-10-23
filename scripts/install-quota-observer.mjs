// Provision the existing passive collector together with the worker observer.
// This owns only its two Python files and its own LaunchAgent.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import{createHash}from'node:crypto';
import{fileURLToPath}from'node:url';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),source=path.dirname(fileURLToPath(import.meta.url));
const {workerProfile}=require('../team-server/worker-kinds.js');
export async function ensureQuotaObserver(options,{runner,home=os.homedir(),platform=process.platform,loadConfig,uid=process.getuid?.()}={}){
 if(options.check||options.dryRun||options.codeOnly||platform!=='darwin')return{installed:false};
 const root=options.workerRoot,config=(loadConfig||require(path.join(root,'src/config.js')).loadConfig)(path.resolve(root,options.workerConfig||'config/worker.local.json'),{root});
 if(config.worker_kind==='codex-repair'||workerProfile(config.worker_id).provider!=='claude')return{installed:false};
 if(config.clickup?.transport!=='rs_hub'||config.testbetrieb?.nur_aufgaben?.length)return{installed:false};
 const directory=path.join(home,'.local/share/max-monitor-quota'),names=['quota_worker.py','quota_usage.py'];
 const inputs=await Promise.all(names.map(name=>fs.readFile(path.join(source,name))));
 let changed=false;for(let i=0;i<names.length;i++){try{if(!(await fs.readFile(path.join(directory,names[i]))).equals(inputs[i]))changed=true;}catch{changed=true;}}
 let loaded=false;try{await runner('/bin/launchctl',['print',`gui/${uid}/de.rs.max-monitor.quota`],{timeout:10000});loaded=true;}catch{}
 if(!changed&&loaded)return{installed:true,changed:false};
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 for(let i=0;i<names.length;i++){const file=path.join(directory,names[i]);await fs.writeFile(file+'.new',inputs[i],{mode:0o600});await fs.rename(file+'.new',file);}
 await runner('/usr/bin/python3',[path.join(directory,'quota_worker.py'),'--install'],{timeout:45000,label:'Verbrauchs-Beobachter einrichten'});
 const proof={at:new Date().toISOString(),workerId:config.worker_id,files:Object.fromEntries(names.map((n,i)=>[n,createHash('sha256').update(inputs[i]).digest('hex')]))};
 await fs.writeFile(path.join(directory,'installation.json'),JSON.stringify(proof),{mode:0o600});return{installed:true,changed:true};
}
