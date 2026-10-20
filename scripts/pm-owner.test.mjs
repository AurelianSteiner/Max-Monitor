import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPmOwners,createPmRoutingReader,SLACK_PM_CHANNELS } from './pm-owner.mjs';

const now=Date.parse('2026-10-18T22:00:00Z');
const row=(extra={})=>({id:'clickup:upload:t1',url:'https://app.clickup.com/t/t1',workflow:'upload',status:'queued',
  phase:'Wartet · PM-Rückfrage',attemptId:'run1',pmOwner:'Historical ClickUp assignee',...extra});
const set=(extra={})=>({id:'set1',mode:'production',taskId:'t1',stage:'klaviyo',runId:'run1',channelId:'C0C994GPYKS',
  team:'Ben & Abdou',threadTs:'1792360000.000001',questions:[{status:'open'}],...extra});

test('PM attribution follows the exact production question channel and preserves both recipients',async()=>{
  const current=row();await applyPmOwners([current],[],{questions:{sets:[set()]},now});
  assert.equal(current.pmOwner,'Ben & Abdou');assert.equal(current.pmCheckedAt,new Date(now).toISOString());
  for(const patch of [{taskId:'other'},{runId:'old'},{stage:'korrektur'},{mode:'test'},
    {channelId:'unknown'},{team:'Aurelian'},{threadTs:'invalid'},{questions:[{status:'replaced'}]}]){
    const current=row();await applyPmOwners([current],[],{questions:{sets:[set(patch)]},now});assert.equal(current.pmOwner,undefined);
  }
  const ambiguous=row();await applyPmOwners([ambiguous],[],{questions:{sets:[set(),set({id:'other'})]},now});
  assert.equal(ambiguous.pmOwner,undefined);
});

test('language packages and ordinary completed work do not borrow PM ownership',async()=>{
  const foreign=row({id:'clickup:translation-fr:t1',workflow:'translation'});
  await applyPmOwners([foreign],[],{questions:{sets:[set({stage:'translation',language:'EN'})]},now});assert.equal(foreign.pmOwner,undefined);
  const done=row({status:'completed',phase:'Fertig',pmOwner:'preserve'});
  await applyPmOwners([done],[],{questions:{sets:[set()]},now});assert.equal(done.pmOwner,'preserve');
});

test('archived questions cannot supply a PM owner or make its current replacement ambiguous',async()=>{
  const archived=set({id:'archived',archivedAt:now-1000,team:'John',channelId:'C0C89DYUDDK'});
  const only=row();await applyPmOwners([only],[],{questions:{sets:[archived]},now});
  assert.equal(only.pmOwner,undefined);
  const current=row();await applyPmOwners([current],[],{questions:{sets:[archived,set()]},now});
  assert.equal(current.pmOwner,'Ben & Abdou');
});

test('routing reuses only the existing customer resolver and caches display metadata for five minutes',async()=>{
  let calls=0,time=now;const routes=createPmRoutingReader('/opt/rs-hub',{clock:()=>time,load:file=>file.endsWith('/pm-questions.js')
    ?{CHANNELS:Object.fromEntries(Object.entries(SLACK_PM_CHANNELS).map(([id,team])=>[team,{id}]))}
    :{resolveCustomer:async(root,id)=>{calls++;assert.equal(root,'/opt/rs-hub');return{taskId:id,team:'Hannes & Luca'};}}});
  const current=row();await applyPmOwners([current],[],{routing:routes,now});assert.equal(current.pmOwner,'Hannes & Luca');
  await routes.resolve('t1');assert.equal(calls,1);time+=300001;await routes.resolve('t1');assert.equal(calls,2);
  const unavailable=row();await applyPmOwners([unavailable],[],{routing:{channels:SLACK_PM_CHANNELS,resolve:async()=>{throw Error('offline');}},now});
  assert.equal(unavailable.pmOwner,undefined);assert.equal(unavailable.status,'queued');
});

test('the Slack PM replaces every generated PM-field caption of a checkpoint finding',async()=>{
  for(const caption of ['PM nicht zugeordnet','PM-Feld leer','PM-Feld nicht eindeutig: Ben Schulte, John Koci','PM: Old Name']){
    const current=row({status:'blocked',phase:'Blockiert · Fortschritt im RS Hub gesichert',responsibleRole:'PM',blockerSource:'checkpoint',
      blockedReason:`Gesicherter Befund: Gutscheincode fehlt. · Zuständig: PM (${caption}) · Nächster Schritt: Gutscheincode eintragen.`});
    await applyPmOwners([current],[],{questions:{sets:[set()]},now});
    assert.equal(current.blockedReason,'Gesicherter Befund: Gutscheincode fehlt. · Zuständig: PM (PM: Ben & Abdou) · Nächster Schritt: Gutscheincode eintragen.');
  }
  const data=row({status:'blocked',phase:'Blockiert',responsibleRole:'Stammdaten (RS Hub/ClickUp)',blockerSource:'checkpoint',
    blockedReason:'Gesicherter Befund: KEY_NOT_SET · Zuständig: Stammdaten (RS Hub/ClickUp) (PM-Feld leer) · Nächster Schritt: Schlüssel speichern.'});
  await applyPmOwners([data],[],{questions:{sets:[set()]},now});
  assert.match(data.blockedReason,/\(PM-Feld leer\)/,'master data is no PM question');
});
