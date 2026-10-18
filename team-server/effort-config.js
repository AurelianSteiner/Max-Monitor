const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PHASES = Object.freeze({
  newsletter: 'Pre-Gen · Bau & Hauptlauf', newsletter_review: 'Pre-Gen · Art Director',
  filing: 'Kundenablage', correction: 'Korrektur', translation: 'Übersetzung', upload: 'Klaviyo-Upload',
  slicing: 'Slicen & Verlinken', sales: 'Sales · Hauptlauf', sales_build: 'Sales · Bau',
  sales_review: 'Sales · Art Director', sales_final: 'Sales · Abnahme & Leser',
});
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function readPolicy(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, 'effort-policy.json'), 'utf8'));
    if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.phases || typeof value.phases !== 'object' || Array.isArray(value.phases) ||
        Object.entries(value.phases).some(([k,v]) => !Object.hasOwn(PHASES,k) || !LEVELS.includes(v))) throw Error('Invalid effort policy');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, revision: 0, phases: {} };
    throw error;
  }
}
function savePolicy(directory, body, actor) {
  if (!body || !Number.isSafeInteger(body.revision) || !body.phases || typeof body.phases !== 'object' ||
      Array.isArray(body.phases) || Object.keys(body).some(k=>!['revision','phases'].includes(k)) ||
      Object.entries(body.phases).some(([k,v])=>!Object.hasOwn(PHASES,k)||!LEVELS.includes(v))) {
    const error = Error('Ungültige Aufwandseinstellungen. Wähle eine der angebotenen Stufen.'); error.status=400; throw error;
  }
  const current = readPolicy(directory);
  if (body.revision !== current.revision) {
    const error = Error('Die Einstellungen wurden inzwischen geändert. Aktualisiere die Ansicht.'); error.status=409; throw error;
  }
  const value = {schema:1, revision:current.revision+1, phases:body.phases,
    updated_at:new Date().toISOString(), updated_by:String(actor.id||'team-owner')};
  fs.mkdirSync(directory,{recursive:true});
  const temporary=path.join(directory,`effort-policy.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});
    fs.renameSync(temporary,path.join(directory,'effort-policy.json'));
  } finally {fs.rmSync(temporary,{force:true});}
  return readPolicy(directory);
}
function consumption(directory, teamId, role, root=process.env.QUOTA_PUBLIC_DIR||'/var/lib/max-monitor-quota/public') {
  let summary=null, error=null;
  try {
    const file=path.join(root,teamId+'.json');
    if(fs.statSync(file).size>2*1024*1024) throw Error('Quota summary too large');
    summary=JSON.parse(fs.readFileSync(file,'utf8'));
    if(summary.schema!==2 || !Array.isArray(summary.by_kind)) throw Error('Quota summary invalid');
  } catch(e) {error=e.code==='ENOENT'?'Die Verbrauchserfassung meldet noch keine Daten.':'Verbrauchsdaten können gerade nicht gelesen werden.';}
  return {summary,error,stale:!summary || !Number.isFinite(Date.parse(summary.generated_at)) || Date.now()-Date.parse(summary.generated_at)>180000,
    policy:readPolicy(directory), phases:PHASES, levels:LEVELS, canManage:['admin','super'].includes(role)};
}
module.exports={PHASES,LEVELS,readPolicy,savePolicy,consumption};
