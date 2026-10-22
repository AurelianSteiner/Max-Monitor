'use strict';

// Positive evidence of a Mac-level operating problem. Unknown system notices
// remain visible in the error inventory without failing the reporting worker.
const WORKER_STAGES = new Set(['claude', 'clickup_list', 'clickup_status', 'poll', 'recover', 'slack', 'slack_claims',
  'sales', 'klaviyo_renderer', 'werkzeuge', 'strom', 'platte', 'rs_skills', 'update_umgebung', 'update', 'rs-hub-mcp']);
const SCOPES = new Set(['run', 'resource', 'worker', 'fleet']);
const WORKER_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function notificationScope(value, text = value?.message || '') {
  const stage = value?.stage || value?.tool || value?.kind;
  if (value?.kind === 'lauf' || stage === 'finalize' || stage === 'finalize_wait') return 'run';
  if (stage === 'filestage_zuordnung') return 'resource';
  if (stage === 'figma_zugang' && value?.art === 'nur_lesen') return 'resource';
  if (SCOPES.has(value?.scope)) return value.scope;
  // These two legacy notices predate explicit scope metadata.
  if (value?.kind === 'update' && /scheitert an den Tests auf \d+ Macs?\b/.test(text) && /main ist[\s\S]*rot/.test(text)) return 'fleet';
  if (stage === 'figma_zugang') {
    if (['nicht_angemeldet', 'kein_seat'].includes(value?.art)
      || /ist in Claude Code nicht bei Figma angemeldet|hat keinen Full-Seat/.test(text)) return 'worker';
    if (/darf die Datei nur lesen/.test(text)) return 'resource';
  }
  if (value?.run_id || value?.task_id || value?.runId || value?.taskId
    || value?.run_ids?.length || value?.task_ids?.length) return 'run';
  if (stage === 'nachbar') return WORKER_ID.test(value?.betrifft || '') ? 'worker' : 'unknown';
  if (value?.kind === 'update' || WORKER_STAGES.has(stage)) return 'worker';
  return 'unknown';
}

function affectedWorker(value) {
  const id = value?.stage === 'nachbar' ? value.betrifft : value?.workerId || value?.worker;
  return typeof id === 'string' && WORKER_ID.test(id) ? id : null;
}

function isWorkerIssue(value, text) {
  return notificationScope(value, text) === 'worker' && affectedWorker(value) !== null;
}

module.exports = { notificationScope, affectedWorker, isWorkerIssue };
