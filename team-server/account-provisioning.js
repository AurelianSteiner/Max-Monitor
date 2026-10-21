// Stores only target-encrypted envelopes. The relay cannot decrypt a Claude token.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATUSES=new Set(['installing','figma_check','ready','figma_login_required','expired','invalid_token','invalid_name','accounts_full','primary_missing','duplicate_account','keychain_locked','environment_override','configuration_error','busy','failed']);
const terminal=status=>!['queued','installing','figma_check'].includes(status);
function validateEndpoint(raw) {
  if(raw==null)return undefined;
  if(!/^[a-f0-9]{64}$/.test(raw.keyId||'') || typeof raw.publicKey!=='string' || !/^[A-Za-z0-9+/=]{400,2048}$/.test(raw.publicKey))throw Error('Ungültiger Account-Empfang');
  const der=Buffer.from(raw.publicKey,'base64'),key=crypto.createPublicKey({key:der,type:'spki',format:'der'});
  if(key.asymmetricKeyType!=='rsa' || key.asymmetricKeyDetails.modulusLength<3072
    || crypto.createHash('sha256').update(der).digest('hex')!==raw.keyId)throw Error('Ungültiger Account-Schlüssel');
  let result;
  if(raw.result) {
    if(!UUID.test(raw.result.id||'') || !STATUSES.has(raw.result.status) || !Number.isFinite(Date.parse(raw.result.updatedAt)))throw Error('Ungültige Account-Bestätigung');
    result={id:raw.result.id,status:raw.result.status,updatedAt:new Date(raw.result.updatedAt).toISOString(),
      ...(['connected','login_required','checking'].includes(raw.result.figma)?{figma:raw.result.figma}:{})};
  }
  return {keyId:raw.keyId,publicKey:raw.publicKey,...(result?{result}:{})};
}
function fileFor(dir,workerId) {
  if(!/^[a-z0-9][a-z0-9-]{1,40}$/.test(workerId||''))throw Error('Ungültiger Mac');
  return path.join(dir,'claude-account-orders',workerId+'.json');
}
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
function publicOrder(order,now=Date.now()) {
  if(!order)return null;
  const expired=!terminal(order.status)&&Date.parse(order.command?.expiresAt)<=now;
  return {id:order.id,status:expired?'expired':order.status,createdAt:order.createdAt,updatedAt:order.updatedAt,...(order.figma?{figma:order.figma}:{})};
}
function enqueue(dir,{workerId,deviceId,endpoint,teamId},raw,now=Date.now()) {
  const fail=message=>{throw Object.assign(Error(message),{status:400});};
  if(!endpoint || raw.keyId!==endpoint.keyId || raw.deviceId!==deviceId || !UUID.test(raw.id||''))fail('Der Mac-Empfang hat sich geändert. Ansicht aktualisieren.');
  if(!['add-account','connect-figma'].includes(raw.action) || Object.keys(raw).some(k=>!['id','action','expiresAt','keyId','deviceId','wrappedKey','iv','ciphertext'].includes(k)))fail('Nur verschlüsselte Account-Daten sind erlaubt.');
  if(typeof raw.expiresAt!=='string' || !(Date.parse(raw.expiresAt)>now) || Date.parse(raw.expiresAt)>now+15*60000+30000)fail('Account-Übertragung abgelaufen. Bitte erneut hinzufügen.');
  const decode=(value,min,max)=>{
    if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail('Verschlüsselte Account-Daten ungültig.');
    const bytes=Buffer.from(value,'base64');if(bytes.length<min||bytes.length>max||bytes.toString('base64')!==value)fail('Verschlüsselte Account-Daten ungültig.');return value;
  };
  const file=fileFor(dir,workerId),old=read(file);
  if(old?.id===raw.id)return publicOrder(old,now);
  if(old && !terminal(publicOrder(old,now).status))throw Object.assign(Error('Auf diesem Mac wird bereits ein Account eingerichtet.'),{status:409});
  const stamp=new Date(now).toISOString();
  const command={id:raw.id,workerId,deviceId,keyId:raw.keyId,teamId,action:raw.action,expiresAt:raw.expiresAt,
    wrappedKey:decode(raw.wrappedKey,384,512),iv:decode(raw.iv,12,12),ciphertext:decode(raw.ciphertext,18,4096)};
  const order={id:raw.id,command,status:'queued',createdAt:stamp,updatedAt:stamp};write(file,order);return publicOrder(order,now);
}
function deliver(dir,report,teamId,now=Date.now()) {
  const file=fileFor(dir,report.workerId),order=read(file);if(!order)return null;
  if(order.command?.deviceId!==report.deviceId || order.command?.keyId!==report.accountProvisioning?.keyId)return null;
  const result=report.accountProvisioning?.result;
  if(result?.id===order.id) {
    order.status=result.status;order.updatedAt=result.updatedAt;order.figma=result.figma;
    if(terminal(order.status))delete order.command;
    write(file,order);
  }
  if(terminal(order.status))return null;
  if(Date.parse(order.command.expiresAt)<=now){order.status='expired';delete order.command;write(file,order);return null;}
  return order.command;
}
function status(dir,workerId){return publicOrder(read(fileFor(dir,workerId)));}
module.exports={validateEndpoint,enqueue,deliver,status,publicOrder};
