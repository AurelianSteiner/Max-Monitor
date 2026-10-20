'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULTS, KINDS, validConfig } = require('./public/planning-model');

function readPlanning(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, 'planning.json'), 'utf8'));
    if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !validConfig(value.config)) throw Error('Invalid planning settings');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, revision: 0, config: { ...DEFAULTS } };
    throw error;
  }
}

function savePlanning(directory, body, actor) {
  if (!body || Object.keys(body).some(k => !['revision', 'config'].includes(k))
    || !Number.isSafeInteger(body.revision) || !validConfig(body.config)) {
    const error = Error('Prüfe Mengen, Arbeitszeiten und Planungsannahmen.'); error.status = 400; throw error;
  }
  const current = readPlanning(directory);
  if (body.revision !== current.revision) {
    const error = Error('Die Teamplanung wurde inzwischen geändert. Verwirf deinen Entwurf und lade den aktuellen Stand.'); error.status = 409; throw error;
  }
  const value = { schema: 1, revision: current.revision + 1, config: { ...DEFAULTS, ...body.config },
    updated_at: new Date().toISOString(), updated_by: String(actor.id || 'team-owner') };
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `planning.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(directory, 'planning.json'));
  } finally { fs.rmSync(temporary, { force: true }); }
  return value;
}

function planningEvidence(summary, fleet, now = Date.now()) {
  const backlog = Object.fromEntries(KINDS.map(k => [k, 0]));
  let unsupportedBacklog = 0, deferred = 0;
  // Full running work is reserved again: deliberately conservative because the
  // remaining fraction and future PM approval time are not measured.
  for (const task of fleet?.queue?.tasks || []) {
    if (!['running', 'queued', 'marked'].includes(task.status)) { if (['paused', 'blocked', 'clarification'].includes(task.status)) deferred++; continue; }
    if (task.phase === 'Wartet · PM-Rückfrage' || task.clarification?.open || (task.tags || []).some(t => String(t).toLowerCase() === 'manuell')) { deferred++; continue; }
    const kind = ({ pregen: 'newsletter', 'pre-gen': 'newsletter', korrektur: 'correction', klaviyo: 'upload' })[task.kind || task.workflow] || task.kind || task.workflow;
    if (KINDS.includes(kind)) backlog[kind]++; else unsupportedBacklog++;
  }
  const lastSuccess = Date.parse(fleet?.queue?.source?.lastSuccessAt);
  const visible = new Set((fleet?.machines || []).map(m => m.workerId).filter(Boolean));
  const raw = summary?.scheduling;
  const scheduling = raw ? { ...raw, workers: Object.fromEntries(Object.entries(raw.workers || {}).filter(([id]) => visible.has(id))),
    routing: { ...raw.routing, fleet: (raw.routing?.fleet || []).filter(m => visible.has(m.worker_id)) } } : null;
  return { generated_at: summary?.generated_at || null, scheduling,
    backlog, unsupportedBacklog, deferred,
    backlogFresh: Number.isFinite(lastSuccess) && lastSuccess <= now + 60000 && now - lastSuccess <= 180000 && !fleet?.queue?.source?.error,
    names: Object.fromEntries((fleet?.machines || []).filter(m => m.workerId).map(m => [m.workerId, m.name || m.workerId])) };
}
module.exports = { readPlanning, savePlanning, planningEvidence };
