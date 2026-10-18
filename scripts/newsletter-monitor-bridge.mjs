#!/usr/bin/env node
// Read-only source adapter; optional central maintenance deletes obsolete error copies.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupErrorCopies, createErrorCleanupWriter } from './error-copy-cleanup.mjs';
import { readPmQuestions, applyPmQuestions } from './pm-question-status.mjs';
import taskState from './task-state.cjs';
import { checkpointBlocker, applyBlockerContexts } from './blocker-context.mjs';
import { createStatusAudit, saveStatusAudit } from './status-reconciliation.mjs';

const require = createRequire(import.meta.url);
export const SOURCE_NAME = 'ClickUp · AI Newsletter Creation';
const STATUSES = new Set(['queued', 'running', 'blocked', 'completed', 'failed']);
const CLAIM_STATES = new Set(['claiming', 'running', 'final', 'released', 'withdrawn']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// AI Newsletter Creation src/jobs.js and src/pre-gen.js: three job kinds, each with
// its own ClickUp tags and Slack claim event. A job ID is <ClickUp-ID>,
// <ClickUp-ID>-klaviyo or <ClickUp-ID>-uebersetzung-<language>.
const CLAIM_EVENTS = { ai_newsletter_claim: 'newsletter', ai_klaviyo_upload_claim: 'klaviyo', ai_translation_claim: 'translation', ai_korrektur_claim: 'correction' };
const TRANSLATION_LANGUAGES = ['en', 'it', 'fr', 'se', 'sp'];
// Render previews: one picture per mail, small enough to read like the real mail
// (600 px = 1x of a 1200 px render) and below the relay's upload limit.
const PREVIEW_WIDTH = 600;
const MAX_PREVIEW_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEWS_PER_TASK = 24;
const PREVIEWS_PER_CYCLE = 40;
const PREVIEW_RETENTION_MS = 7 * 86400000;

// startStatuses: the ClickUp status that commissions this workflow (worker
// src/workflow-status.js). Tags then only describe progress and history; a
// waiting or running tag outside that status is no order.
export const DEFAULT_WORKFLOWS = [
  { id: 'newsletter', triggerTags: ['pre gen.'], claimWorkflow: 'newsletter', startStatuses: ['pre-gen'], stateTags: {
    queued: ['pre gen · wartet', 'pre gen · pausiert'], running: ['pre gen · läuft'],
    blocked: ['pre gen · blockiert'], completed: ['pre gen · fertig'],
  } },
  { id: 'upload', triggerTags: ['klaviyo upload'], claimWorkflow: 'klaviyo', startStatuses: ['klaviyo upload'], stateTags: {
    queued: ['klaviyo upload · wartet', 'klaviyo upload · pausiert'], running: ['klaviyo upload · läuft'],
    blocked: ['klaviyo upload · blockiert'], completed: ['klaviyo upload · fertig'],
  } },
  // Legacy language tags describe history, never a new order. Keep actual
  // reservations and terminal outcomes visible while the worker is status-driven.
  ...TRANSLATION_LANGUAGES.map(language => ({ id: `translation-${language}`, queueWorkflow: 'translation', titleSuffix: language.toUpperCase(),
    triggerTags: [`${language} translation`, `${language} translations`], claimWorkflow: `translation-${language}`, reservationOnly: true, stateTags: {
      blocked: [`${language} translation · blockiert`], completed: [`${language} translation · fertig`],
    } })),
];

export function normalizeTag(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]/gu, '');
}

export function displayText(value, max, fallback) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return text || fallback;
}

export function validateWorkflows(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error('Workflow-Liste muss 1–30 Einträge enthalten.');
  const ids = new Set();
  for (const workflow of value) {
    if (!workflow || !/^[a-z][a-z0-9-]{0,39}$/.test(workflow.id) || ids.has(workflow.id)) throw new Error('Workflow-IDs müssen eindeutig und gültig sein.');
    ids.add(workflow.id);
    if (workflow.queueWorkflow !== undefined && !/^[a-z][a-z0-9-]{0,39}$/.test(workflow.queueWorkflow)) throw new Error(`Queue-Workflow ungültig: ${workflow.id}.`);
    if (workflow.titleSuffix !== undefined && (typeof workflow.titleSuffix !== 'string' || !/^[\p{L}\p{N} ]{1,20}$/u.test(workflow.titleSuffix))) throw new Error(`Titelzusatz ungültig: ${workflow.id}.`);
    if (workflow.reservationOnly !== undefined && typeof workflow.reservationOnly !== 'boolean') throw new Error(`Reservierungspflicht ungültig: ${workflow.id}.`);
    if (!Array.isArray(workflow.triggerTags) || !workflow.triggerTags.length) throw new Error(`Start-Tags fehlen: ${workflow.id}.`);
    if (workflow.startStatuses !== undefined && (!Array.isArray(workflow.startStatuses) || !workflow.startStatuses.length || workflow.startStatuses.length > 10
      || workflow.startStatuses.some(status => typeof status !== 'string' || !normalizeStatus(status) || status.length > 60 || /[\u0000-\u001f\u007f]/.test(status))))
      throw new Error(`Start-Status ungültig: ${workflow.id}.`);
    for (const [status, tags] of Object.entries(workflow.stateTags ?? {})) {
      if (!STATUSES.has(status) || !Array.isArray(tags)) throw new Error(`Status-Tags ungültig: ${workflow.id}.`);
    }
    const tags = [...workflow.triggerTags, ...Object.values(workflow.stateTags ?? {}).flat()];
    if (tags.some(tag => typeof tag !== 'string' || !normalizeTag(tag) || tag.length > 200)) throw new Error(`Tag ungültig: ${workflow.id}.`);
  }
  return value;
}

export function workflowMatches(workflow, tags) {
  const configured = [...workflow.triggerTags, ...Object.values(workflow.stateTags ?? {}).flat()].map(normalizeTag);
  return tags.some(tag => configured.includes(normalizeTag(tag)));
}

// The bridge reads Slack with the Tuck token the worker Macs use. A 429 (or
// Slack's 'ratelimited') is marked so callers can fall back instead of failing.
const rateLimitError = message => Object.assign(new Error(message), { code: 'RATE_LIMITED' });
export function isRateLimited(error) { return error?.code === 'RATE_LIMITED'; }

// HTTP refusal of one task's read: 4xx except 429, never a 5xx or transport
// error (worker src/clickup-source.js perTaskRefusal).
export function perTaskRefusal(error) {
  const status = Number(error?.status);
  return status >= 400 && status < 500 && status !== 429;
}

async function requestJson(hubFetch, url, service) {
  const response = await hubFetch(url, { method: 'GET' });
  if (!response.ok) {
    const message = `${service}: HTTP ${response.status}.`;
    throw Object.assign(response.status === 429 ? rateLimitError(message) : new Error(message), { status: response.status });
  }
  const data = await response.json();
  if (!data || typeof data !== 'object') throw new Error(`${service}: ungültige Antwort.`);
  if (service === 'Slack' && data.ok !== true) {
    const message = `Slack: ${/^[a-z_]+$/.test(data.error) ? data.error : 'Abfrage fehlgeschlagen'}.`;
    throw data.error === 'ratelimited' ? rateLimitError(message) : new Error(message);
  }
  return data;
}

export async function discoverTags(hubFetch, workspaceId, workflows) {
  const spaces = await requestJson(hubFetch, `https://api.clickup.com/api/v2/team/${encodeURIComponent(workspaceId)}/space?archived=false`, 'ClickUp');
  if (!Array.isArray(spaces.spaces)) throw new Error('ClickUp: Space-Liste fehlt.');
  // ClickUp filters tags by their exact spelling, even when our matching is normalized.
  const variants = new Set();
  for (const space of spaces.spaces) {
    const result = await requestJson(hubFetch, `https://api.clickup.com/api/v2/space/${encodeURIComponent(space.id)}/tag`, 'ClickUp');
    if (!Array.isArray(result.tags)) throw new Error('ClickUp: Tag-Liste fehlt.');
    for (const tag of result.tags) {
      if (typeof tag?.name === 'string' && workflows.some(workflow => workflowMatches(workflow, [tag.name]))) variants.add(tag.name);
    }
  }
  return [...variants];
}

export async function listTasks(hubFetch, workspaceId, variants, { maxPages = 200, pageSize = 100 } = {}) {
  const tasks = new Map();
  if (!variants.length) return [];
  // ClickUp joins several tags[] with OR (also relied on by the worker). One
  // paginated query keeps the minute cadence within the shared Hub token's limit.
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`https://api.clickup.com/api/v2/team/${encodeURIComponent(workspaceId)}/task`);
    for (const [key, value] of Object.entries({ page, subtasks: true, include_closed: false })) url.searchParams.set(key, String(value));
    for (const tag of variants) url.searchParams.append('tags[]', tag);
    const result = await requestJson(hubFetch, url, 'ClickUp');
    if (!Array.isArray(result.tasks)) throw new Error('ClickUp: Aufgabenliste fehlt.');
    for (const task of result.tasks) {
      if (!task || typeof task.id !== 'string' || !task.id || !Array.isArray(task.tags)) throw new Error('ClickUp: ungültige Aufgabe.');
      tasks.set(task.id, task);
    }
    if (result.last_page === true || result.tasks.length < pageSize) return [...tasks.values()];
  }
  throw new Error('ClickUp: Aufgabenliste unvollständig; bisherige Queue bleibt erhalten.');
}

// The worker's own order listing (src/clickup-source.js listTaggedTasksOnce):
// every task in a start status is an order, whether or not a tag was written yet.
export async function listStatusTasks(hubFetch, workspaceId, statuses, { maxPages = 200, pageSize = 100 } = {}) {
  if (!statuses.length) return [];
  const wanted = new Set(statuses.map(normalizeStatus));
  const tasks = new Map();
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`https://api.clickup.com/api/v2/team/${encodeURIComponent(workspaceId)}/task`);
    for (const [key, value] of Object.entries({ page, subtasks: true, include_closed: false })) url.searchParams.set(key, String(value));
    for (const status of statuses) url.searchParams.append('statuses[]', status);
    const result = await requestJson(hubFetch, url, 'ClickUp');
    if (!Array.isArray(result.tasks)) throw new Error('ClickUp: Aufgabenliste fehlt.');
    for (const task of result.tasks) {
      if (!task || typeof task.id !== 'string' || !task.id || !Array.isArray(task.tags)) throw new Error('ClickUp: ungültige Aufgabe.');
      if (wanted.has(normalizeStatus(taskStatus(task)))) tasks.set(task.id, task);
    }
    if (result.last_page === true || result.tasks.length < pageSize) return [...tasks.values()];
  }
  throw new Error('ClickUp: Statusliste unvollständig; bisherige Queue bleibt erhalten.');
}

// A refused status read is not repeated for 15 minutes (worker TASK_WARNING_MS):
// the shared Hub token is not spent on up to 100 single reads per cycle.
export const STATUS_REFUSAL_MS = 15 * 60000;

// Status epochs exactly as the worker builds its job IDs (<id>@<since>): one
// official batch per 100 tasks. A task whose status changed during the read
// keeps no epoch until the next cycle. Like the worker (F26, Till 16.10.2026),
// a refused batch is read task by task and a refused single read leaves only
// that task without an epoch; 429, 5xx and transport errors fail the cycle.
// refusals (taskId -> { status, at }) carries refused tasks across cycles.
export async function readStatusEpochs(hubFetch, tasks, { groupSize = 100, refusals = new Map(), now = Date.now(), onRefused = () => {} } = {}) {
  const epochs = new Map();
  const record = (data, task) => {
    const current = data?.current_status;
    const since = current?.since ?? current?.total_time?.since;
    if (normalizeStatus(current?.status) === normalizeStatus(taskStatus(task)) && /^\d+$/.test(String(since ?? ''))) epochs.set(task.id, String(since));
  };
  for (const [id, entry] of refusals) if (!(now - entry.at >= 0 && now - entry.at < STATUS_REFUSAL_MS)) refusals.delete(id);
  const single = async task => {
    try { record(await requestJson(hubFetch, `https://api.clickup.com/api/v2/task/${encodeURIComponent(task.id)}/time_in_status`, 'ClickUp'), task); }
    catch (error) {
      if (!perTaskRefusal(error)) throw error;
      refusals.set(task.id, { status: error.status, at: now });
      onRefused(task, error.status);
    }
  };
  const pending = tasks.filter(task => !refusals.has(task.id));
  for (let offset = 0; offset < pending.length; offset += groupSize) {
    const group = pending.slice(offset, offset + groupSize);
    if (group.length === 1) { await single(group[0]); continue; }
    const url = new URL('https://api.clickup.com/api/v2/task/bulk_time_in_status/task_ids');
    for (const task of group) url.searchParams.append('task_ids', task.id);
    let times;
    try { times = await requestJson(hubFetch, url, 'ClickUp'); }
    catch (error) { if (!perTaskRefusal(error)) throw error; }
    for (const task of group) {
      if (times) record(times[task.id], task);
      else await single(task);
    }
  }
  return epochs;
}

// Row phase of an order whose status epoch ClickUp refused: the worker lists it
// but never reserves it until the epoch is readable.
function refusedPhase(task) {
  return Number.isInteger(task.statusRefused) ? `Statusbeginn nicht lesbar (HTTP ${task.statusRefused}) · wird nicht reserviert` : undefined;
}

// AI Newsletter Creation src/workflow-status.js: only these ClickUp statuses
// commission work; progress tags never do. The worker lists exactly these.
export const START_STATUSES = Object.freeze(['pre-gen', 'revision intern', 'revision extern', 'klaviyo upload']);
const CORRECTION_STATUSES = Object.freeze({ 'revision intern': 'intern', 'revision extern': 'extern' });
const CORRECTION_JOB = /^(?:korrektur-)?cu-([A-Za-z0-9_-]+)@(\d+)-(intern|extern)(?:-file-[a-f0-9]{31,32})?$/;
const LIVE_CLAIM_STATES = new Set(['claiming', 'running']);

export function normalizeStatus(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function taskStatus(task) {
  return typeof task?.status === 'string' ? task.status : task?.status?.status;
}

// Worker job kind of a start status (worker src/workflow-status.js statusKind).
const STATUS_KINDS = Object.freeze({ 'pre-gen': 'newsletter', 'klaviyo upload': 'klaviyo', 'revision intern': 'korrektur', 'revision extern': 'korrektur' });
function statusKindOf(task) {
  return STATUS_KINDS[normalizeStatus(taskStatus(task))] ?? null;
}

const hasManualTag = task => (task?.tags || []).some(tag => normalizeTag(typeof tag === 'string' ? tag : tag?.name) === normalizeTag('manuell'));

// The worker's job ID of a dated order (src/clickup-source.js compactTask).
function workerJobId(task, kind, since) {
  const key = `${task.id}@${since}`;
  if (kind === 'korrektur') return `korrektur-cu-${key}-${CORRECTION_STATUSES[normalizeStatus(taskStatus(task))]}`;
  return kind === 'klaviyo' ? `${key}-klaviyo` : key;
}

// Why the worker's admit() (src/clickup-source.js) never reserves an order.
export const PARK_REASONS = Object.freeze(['Testumgebung', 'manuell', 'Pop-up', 'Altbestand']);

// The worker's own admission predicates, loaded from --worker-root:
// test-workspace.js admission, upload-policy.js manualHold/uploadPolicy,
// slack-kanaele.js aufgabenArt and the cutover jobs. Without them (an older
// source installation) only the 'manuell' tag parks an order, as before.
export function workerAdmission({ manualHold, uploadPolicy, admission, aufgabenArt, cutoverJobs } = {}) {
  return {
    // Klaviyo uploads the worker leaves to a person: the tag or a folder from
    // config/manual-uploads.json (Prinz).
    manualUpload: task => uploadPolicy ? Boolean(uploadPolicy(task)?.manual) : hasManualTag(task),
    // The reason the worker would not reserve this order of kind newsletter,
    // klaviyo or korrektur, or null. Without an epoch only the reasons that need
    // none are checked; the worker never dates those orders either.
    parked(task, kind, since) {
      if (!kind) return null;
      if (admission?.(task, kind)) return 'Testumgebung';
      // The Prinz upload marker binds only the upload; a PM-set 'manuell' parks every kind.
      if (manualHold ? manualHold(task, kind) : hasManualTag(task)) return 'manuell';
      // Pop-ups have no automatic correction or upload (docs/ablauf.md, Till 16.10.2026).
      if (['korrektur', 'klaviyo'].includes(kind) && aufgabenArt?.(task) === 'popup') return 'Pop-up';
      if (since && cutoverJobs?.has(workerJobId(task, kind, since))) return 'Altbestand';
      return null;
    },
  };
}

// Each worker file is optional: a missing or incomplete one keeps the tag-only
// rule for its part and is named in missing.
export function loadWorkerAdmission(root, load = require) {
  const predicates = {}, missing = [];
  const take = (relative, pick) => {
    try {
      const value = pick(load(path.join(root, relative)));
      if (!value) throw new Error('unvollständig');
      Object.assign(predicates, value);
    } catch { missing.push(relative); }
  };
  take('src/upload-policy.js', module => typeof module?.manualHold === 'function' && typeof module.uploadPolicy === 'function'
    && { manualHold: module.manualHold, uploadPolicy: module.uploadPolicy });
  take('src/test-workspace.js', module => typeof module?.admission === 'function' && { admission: module.admission });
  take('src/slack-kanaele.js', module => typeof module?.aufgabenArt === 'function' && { aufgabenArt: module.aufgabenArt });
  take('config/workflow-cutover.json', data => Array.isArray(data?.jobs) && data.jobs.every(job => typeof job === 'string')
    && { cutoverJobs: new Set(data.jobs) });
  return { admission: workerAdmission(predicates), missing };
}

// Job kind, ClickUp ID and status epoch of a worker job ID (src/jobs.js, compactTask).
function jobIdentity(value) {
  const jobId = String(value ?? '');
  const correction = CORRECTION_JOB.exec(jobId);
  const translation = /^(.+)-uebersetzung-(en|it|fr|se|sp)$/.exec(jobId);
  const upload = /^(.+)-klaviyo$/.exec(jobId);
  const base = correction?.[1] ?? translation?.[1] ?? upload?.[1] ?? jobId;
  return { kind: correction ? 'correction' : translation ? 'translation' : upload ? 'klaviyo' : 'newsletter',
    taskId: base.replace(/@\d+$/, ''), workflow: translation ? `translation-${translation[2]}` : undefined,
    epoch: correction?.[2] ?? /@(\d+)$/.exec(base)?.[1] };
}

// Outcome, link and labels from the claim text the worker renders for both
// Slack and the RS Hub register (src/slack-notifier.js claimText).
function claimDetails(kind, state, paused, text, reactions) {
  const link = /<([^|>]+)\|([^>]+)>/.exec(text.split('\n')[1] || '');
  let url;
  try { const candidate = new URL(link?.[1]); if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && candidate.href.length <= 2000) url = candidate.href; } catch { /* Optional task link. */ }
  // Completed corrections replace the parent text and need no separate reaction.
  // Only the terminal label of this exact claim can confirm completion.
  const terminalLine = text.split('\n')[1] || '';
  const doneLabel = kind === 'correction' && state === 'final' && /^(?:✅|:white_check_mark:)\s*Fertig:/u.test(terminalLine);
  return { doneLabel, ...claimOutcome(kind, state, paused, doneLabel, reactions),
    url, company: kind === 'correction' ? displayText(text.split('\n')[0].replace(/^\*?Korrektur\s*·\s*/, '').replace(/[*`]/g, ''), 200) : undefined,
    title: displayText((link?.[2] || text.split('\n')[0].replace(/[*`]/g, '')).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), 300) };
}

function claimOutcome(kind, state, paused, doneLabel, reactions) {
  return {
    outcome: doneLabel || (['final', 'released'].includes(state) && reactions.includes('white_check_mark')) ? 'completed'
      : paused && state === 'final' ? 'queued' : reactions.includes('x') ? 'blocked' : undefined,
    awaitingPm: kind === 'correction' && state === 'final' && reactions.includes('question'),
  };
}

export function parseClaim(message) {
  const kind = CLAIM_EVENTS[message?.metadata?.event_type];
  if (!kind) return null;
  const value = message.metadata.event_payload;
  if (!value?.task_id || !value.worker || !value.run_id || !CLAIM_STATES.has(value.state)) return null;
  const heartbeat = Number(value.heartbeat) || Number(message.ts);
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) return null;
  // Like the worker: event type and job ID must agree, or the claim belongs to no task.
  const jobId = String(value.task_id);
  const identity = jobIdentity(jobId);
  if (kind !== identity.kind) return null;
  const reactions = (Array.isArray(message.reactions) ? message.reactions : []).map(item => item?.name);
  return { taskId: identity.taskId, jobId,
    runId: String(value.run_id), workerId: String(value.worker),
    state: value.state, heartbeat, completionTimestampKnown: Number.isFinite(Number(value.heartbeat)) && Number(value.heartbeat) > 0,
    ts: String(message.ts),
    ...(value.paused === true ? { paused: true, ...(value.portable === true ? { portable: true } : {}) } : {}),
    workflow: typeof value.workflow === 'string' ? value.workflow : identity.workflow ?? kind,
    reactions: reactions.filter(name => typeof name === 'string'),
    ...claimDetails(kind, value.state, value.paused === true, String(message.text ?? ''), reactions) };
}

// One reservation of the RS Hub register (AI Newsletter Creation
// src/hub-reservation-protocol.js). The workers admit and own work by exactly
// these documents; Slack posts are their delayed delivery.
export function parseRegisterClaim(doc) {
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,240}$/.test(value);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !id(doc.taskId) || !id(doc.runId)
    || typeof doc.worker !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(doc.worker) || !CLAIM_STATES.has(doc.state)
    || typeof doc.ts !== 'string' || !/^\d+\.\d+$/.test(doc.ts)) return null;
  const jobId = doc.taskId;
  // Separate test orders and legacy Freigaben IDs are no monitor jobs (as in parseClaim).
  if (/-klaviyo-pruefauftrag$/.test(jobId) || (/^korrektur-/.test(jobId) && !CORRECTION_JOB.test(jobId))) return null;
  const heartbeat = Number(doc.heartbeat);
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) return null;
  const identity = jobIdentity(jobId);
  const reactions = Array.isArray(doc.reactions) ? doc.reactions.filter(name => typeof name === 'string') : [];
  const paused = doc.paused === true;
  return { taskId: identity.taskId, jobId, runId: doc.runId, workerId: doc.worker, state: doc.state,
    // A heartbeat proves a live owner. The Hub renews it on every sync, also for
    // terminal reservations, so it never dates a completion; a terminal one keeps
    // its stable reservation time instead (row times bind operator decisions).
    heartbeat: LIVE_CLAIM_STATES.has(doc.state) ? heartbeat : Number(doc.ts), completionTimestampKnown: false, ts: doc.ts,
    threadTs: typeof doc.slackTs === 'string' && /^\d+\.\d+$/.test(doc.slackTs) ? doc.slackTs : null,
    // Thread replies change with the Slack post, not with every Hub sync.
    threadHeartbeat: null,
    ...(paused ? { paused: true, ...(doc.portable === true ? { portable: true } : {}) } : {}),
    workflow: identity.workflow ?? identity.kind, reactions, hub: true,
    ...(typeof doc.channel === 'string' && /^C[A-Z0-9]{5,20}$/.test(doc.channel) ? { channelId: doc.channel } : {}),
    ...claimDetails(identity.kind, doc.state, paused, String(doc.text ?? ''), reactions) };
}

// Same runtime directory as the worker transport's remote script:
// HUB_RUNTIME_DIR from <hub>/.env, otherwise the Hub root itself.
export function hubRuntimeDirectory(localHub, readFile = fsSync.readFileSync) {
  let runtime = '';
  try {
    for (const line of String(readFile(path.join(localHub, '.env'), 'utf8')).split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match?.[1] === 'HUB_RUNTIME_DIR') runtime = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('RS-Hub-Konfiguration (.env) ist nicht lesbar.'); }
  runtime ||= localHub;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(runtime) || runtime.split('/').includes('..')) throw new Error('HUB_RUNTIME_DIR des RS Hub ist kein sicherer absoluter Pfad.');
  return runtime;
}

// Read-only view of the Hub reservation register. null: the Hub has not
// switched to it (no register or no enabled marker); then Slack stays the source.
export function readHubReservations(runtimeDir, { now = Date.now(), lookbackDays = 60,
  openDatabase = file => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true, timeout: 2000 }) } = {}) {
  const root = path.join(runtimeDir, 'state', 'worker-reservations');
  const file = path.join(root, 'claims.sqlite');
  if (!fsSync.existsSync(path.join(root, 'enabled')) || !fsSync.existsSync(file)) return null;
  const db = openDatabase(file);
  try {
    // Like the Slack history: terminal reservations within the lookback, live ones always.
    const oldest = now / 1000 - lookbackDays * 86400;
    const claims = [];
    for (const row of db.prepare('SELECT doc FROM reservations').all()) {
      let doc;
      try { doc = JSON.parse(row.doc); } catch { continue; }
      const claim = parseRegisterClaim(doc);
      if (claim && (LIVE_CLAIM_STATES.has(claim.state) || Number(claim.ts) >= oldest)) claims.push(claim);
    }
    return claims;
  } finally { db.close(); }
}

// The register decides ownership, state and pause exactly as for the workers.
// Slack contributes only what the register cannot: the parent thread for
// progress replies, its reactions and the time a terminal post was written.
export function mergeHubClaims(slackClaims, hubClaims) {
  if (!Array.isArray(hubClaims)) return slackClaims;
  const posted = new Map();
  for (const claim of slackClaims) {
    const old = posted.get(claim.runId);
    if (!old || compareSlackTs(claim.ts, old.ts) > 0) posted.set(claim.runId, claim);
  }
  const owned = new Set(hubClaims.map(claim => claim.runId));
  const merged = slackClaims.filter(claim => !owned.has(claim.runId));
  for (const hub of hubClaims) {
    const slack = posted.get(hub.runId);
    if (!slack) { merged.push(hub); continue; }
    const live = LIVE_CLAIM_STATES.has(hub.state);
    const settled = !live && !LIVE_CLAIM_STATES.has(slack.state);
    const reactions = [...new Set([...(slack.reactions || []), ...hub.reactions])];
    const kind = jobIdentity(hub.jobId).kind;
    merged.push({ ...hub,
      heartbeat: settled ? slack.heartbeat : hub.heartbeat,
      completionTimestampKnown: settled && slack.completionTimestampKnown !== false,
      threadTs: slack.ts, threadHeartbeat: slack.heartbeat, channelId: hub.channelId || slack.channelId, reactions,
      url: hub.url || slack.url, title: hub.title || slack.title, company: hub.company ?? slack.company,
      ...claimOutcome(kind, hub.state, hub.paused === true, hub.doneLabel || (slack.doneLabel && !live), reactions) });
  }
  return merged;
}

export async function listClaims(hubFetch, channelId, { now = Date.now(), maxPages = 100, lookbackDays = 60, oldest, onMessage = () => {} } = {}) {
  const claims = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL('https://slack.com/api/conversations.history');
    // 999 per page like the worker's readClaims: up to 10x fewer calls on the shared token.
    const since = oldest !== undefined ? { oldest } : lookbackDays === null ? {} : { oldest: ((now - lookbackDays * 86400000) / 1000).toFixed(6) };
    for (const [key, value] of Object.entries({ channel: channelId, include_all_metadata: true, limit: 999,
      ...since, ...(cursor ? { cursor } : {}) })) url.searchParams.set(key, String(value));
    const result = await requestJson(hubFetch, url, 'Slack');
    if (!Array.isArray(result.messages)) throw new Error('Slack: Nachrichtenliste fehlt.');
    for (const message of result.messages) { onMessage(message); const claim = parseClaim(message); if (claim) claims.push({ ...claim, channelId }); }
    cursor = result.response_metadata?.next_cursor;
    if (!result.has_more) return claims;
    if (typeof cursor !== 'string' || !cursor) throw new Error('Slack: Cursor fehlt; Reservierungen unvollständig.');
  }
  throw new Error('Slack: Reservierungen unvollständig; bisherige Queue bleibt erhalten.');
}

// Slack message IDs compared exactly (seconds and microseconds as digit strings).
export function compareSlackTs(a, b) {
  const [ai, af = ''] = String(a).split('.'), [bi, bf = ''] = String(b).split('.');
  if (ai.length !== bi.length) return ai.length - bi.length;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const x = af.padEnd(6, '0'), y = bf.padEnd(6, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

export const CLAIM_CACHE_MS = 180000;
export const RATE_LIMIT_FALLBACK_MS = 600000;
export const ERROR_RESCAN_MS = 1800000;

// Claim channels: one complete read per 180 s (the loop runs every 60 s).
// incremental (#ai-fehler): only messages newer than the newest one seen, with a
// complete rescan every 30 min or after invalidate(); deletions and edits of
// older copies appear with that rescan.
// A 429 reuses a read under 10 min old. Such a cycle feeds only the display:
// stats tell the caller, and the error-copy cleanup waits for a fresh cycle.
// A 429 or another failed read marks the claim channel stale (its data stays for
// the display). due() lets the caller decide once per cycle whether every claim
// channel is read (refresh), so the channels never drift into separate cycles.
export function createClaimReader({ ttlMs = CLAIM_CACHE_MS, fallbackMs = RATE_LIMIT_FALLBACK_MS, rescanMs = ERROR_RESCAN_MS } = {}) {
  const cache = new Map();
  const stats = { fresh: 0, cached: 0, fallback: 0 };
  const replay = (entry, options) => {
    for (const message of entry.messages) options.onMessage?.(message);
    return entry.claims;
  };
  const current = (entry, options) => {
    if (!entry || entry.incremental || entry.stale || entry.lookbackDays !== options.lookbackDays) return false;
    const age = options.now - entry.at;
    return age >= 0 && age < ttlMs;
  };
  const reader = async (hubFetch, channelId, options) => {
    const old = cache.get(channelId);
    const usable = Boolean(old) && old.lookbackDays === options.lookbackDays && old.incremental === Boolean(options.incremental);
    const age = usable ? options.now - old.at : NaN;
    if (usable && !options.refresh && current(old, options)) { stats.cached += 1; return replay(old, options); }
    const sinceFull = usable ? options.now - old.fullAt : NaN;
    const incremental = usable && old.incremental && typeof old.newest === 'string' && sinceFull >= 0 && sinceFull < rescanMs;
    const all = [], kept = [];
    let newest = incremental ? old.newest : undefined;
    let claims;
    try {
      claims = await listClaims(hubFetch, channelId, { ...options, ...(incremental ? { oldest: old.newest } : {}), onMessage: message => {
        all.push(message);
        if (typeof message?.ts === 'string' && /^\d+\.\d+$/.test(message.ts) && (!newest || compareSlackTs(message.ts, newest) > 0)) newest = message.ts;
        // Run errors are inventory too. A warm cache must replay the same errors
        // as a fresh read, including errors older than the claims lookback.
        if (message.metadata?.event_type === 'ai_newsletter_fehler' || parseWorkerIssue(message)) kept.push(message);
      } });
    } catch (error) {
      if (usable && !old.incremental) cache.set(channelId, { ...old, stale: true });
      if (isRateLimited(error) && usable && age >= 0 && age < fallbackMs) { stats.fallback += 1; return replay(old, options); }
      throw error;
    }
    stats.fresh += 1;
    if (incremental) {
      const added = new Set(kept.map(message => message.ts));
      const claimIds = new Set(claims.map(claim => claim.ts));
      const entry = { ...old, at: options.now, newest, messages: [...kept, ...old.messages.filter(message => !added.has(message.ts))],
        claims: [...claims, ...old.claims.filter(claim => !claimIds.has(claim.ts))] };
      cache.set(channelId, entry);
      return replay(entry, options);
    }
    cache.set(channelId, { at: options.now, fullAt: options.now, lookbackDays: options.lookbackDays,
      incremental: Boolean(options.incremental), newest, claims, messages: kept });
    for (const message of all) options.onMessage?.(message);
    return claims;
  };
  reader.invalidate = channelId => cache.delete(channelId);
  // True when any of these claim channels is missing, expired or stale.
  reader.due = (channelIds, options) => channelIds.some(channelId => !current(cache.get(channelId), options));
  reader.stats = stats;
  return reader;
}

// True when every channel of a cycle was read completely in that cycle.
export function freshClaimCycle(before, after) {
  return after.cached === before.cached && after.fallback === before.fallback;
}

export function parseWorkerIssue(message) {
  const text = typeof message?.text === 'string' ? message.text : '';
  // Older workers omit metadata only for this exact system-error template.
  const legacy = message?.bot_id && /^(?:⚠️|:warning:) AI-Newsletter-Worker auf Mac `([a-z0-9][a-z0-9._-]{0,79})`: technischer Fehler bei ([A-Za-z0-9_-]+) \(([A-Za-z0-9_-]+)\)\. Lokales Log prüfen\.$/i.exec(text);
  const value = message?.metadata?.event_type === 'ai_newsletter_fehler' ? message.metadata.event_payload
    : legacy ? { kind: 'system', worker: legacy[1], stage: legacy[2] } : null;
  if (!value || !['system', 'update'].includes(value.kind) || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.worker)) return null;
  const time = Number(message.ts) * 1000;
  if (!Number.isFinite(time) || time <= 0 || time > 8640000000000000) return null;
  const detail = legacy ? `Technischer Fehler (${legacy[3]}). Lokales Log prüfen.`
    : /```([\s\S]*?)```/.exec(text)?.[1] || text.split('\n')[0];
  const warning = /^(?:⏳|:hourglass(?:_flowing_sand)?:)/.test(text) && !/abgelaufen/.test(text);
  // Keep only the diagnosis, never commands, credentials or entire Slack messages.
  const safe = detail.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[ENTFERNT]')
    .replace(/\b(?:xox[abposr]-|sk-|gh[opsu]_)[A-Za-z0-9_-]+/g, '[ENTFERNT]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [ENTFERNT]')
    .replace(/((?:api[_-]?key|token|secret|password|passwort)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[ENTFERNT]')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const stage = displayText(value.stage || value.tool || value.kind, 80);
  return { id: String(message.ts), workerId: value.worker, stage,
    severity: warning ? 'warning' : 'error', message: displayText(safe, 500, `Worker-Fehler bei ${stage}`),
    reportedAt: new Date(time).toISOString() };
}

// Workflow kind, ClickUp ID and monitor task ID of a job in an error copy.
function errorJob(jobId, lauf) {
  const correction = /^(?:korrektur-)?cu-([A-Za-z0-9_-]+)@\d+-(?:intern|extern)(?:-file-[a-f0-9]{31,32})?$/.exec(jobId);
  const translation = /^(.+)-uebersetzung-(en|it|fr|se|sp)$/.exec(jobId);
  const upload = /^(.+)-klaviyo$/.exec(jobId);
  const kind = correction ? 'correction' : translation ? `translation-${translation[2]}` : upload ? 'upload' : lauf ? 'newsletter' : 'worker-errors';
  const taskId = (correction?.[1] || translation?.[1] || upload?.[1] || jobId).replace(/@\d+$/, '');
  return { kind, taskId, sourceId: correction ? `correction:${jobId}` : `clickup:${kind}:${taskId}`,
    workflow: kind.startsWith('translation-') ? 'translation' : kind };
}

// Worker run state of an order whose ClickUp status was withdrawn (src/slack-notifier.js
// fehlerKopieText abgebrochen: „🛑 Abgebrochen: ClickUp-Status zurückgezogen“).
const WITHDRAWN_RUN_STATE = 'abgebrochen_tag_entfernt';

// Further orders of a cause post (#ai-fehler nur bei menschlichem Handlungsbedarf,
// Till, 17.10.2026): task_ids with their run_ids at the same index.
const CAUSE_JOB = /^[A-Za-z0-9_@-]{1,120}$/;
const MAX_CAUSE_ROWS = 50;
// The relay rejects the whole snapshot when one row breaks its bounds
// (team-server/fleet.js validateQueue: task.id 160, task.attemptId 200).
const MAX_ROW_ID = 160, MAX_ATTEMPT_ID = 200;
function causeJobs(value, primary, rowId) {
  const jobs = Array.isArray(value?.task_ids) ? value.task_ids.slice(0, MAX_CAUSE_ROWS) : [];
  const runs = Array.isArray(value?.run_ids) && value.run_ids.length === value.task_ids.length ? value.run_ids : [];
  const seen = new Set([primary]);
  const result = [];
  jobs.forEach((job, index) => {
    if (typeof job !== 'string' || !CAUSE_JOB.test(job) || seen.has(job) || `${rowId}#${job}`.length > MAX_ROW_ID) return;
    seen.add(job);
    const run = runs[index];
    result.push({ job, attemptId: typeof run === 'string' && run.length <= MAX_ATTEMPT_ID && /^[A-Za-z0-9_.@:-]+$/.test(run) ? run : undefined });
  });
  return result;
}

// One row per still-present bot error in #ai-fehler, independent of historical
// ClickUp tags, claim outcomes and canceled Sales tests. A cause post that names
// several orders (task_ids) gives one row per order, each with the same Slack
// link. Removing the error in Slack removes its rows on the next complete scan.
// Never synthesize completion.
export function buildBlockedErrors(messages, channelId, tasks = [], { manualUploadIds = new Set() } = {}) {
  const rows = new Map();
  const slackText = text => String(text || '').replace(/<[^|>]+\|([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const message of messages) {
    if (message.thread_ts && message.thread_ts !== message.ts) continue;
    const issue = parseWorkerIssue(message);
    const value = message.metadata?.event_type === 'ai_newsletter_fehler' ? message.metadata.event_payload : null;
    if (!value && !issue) continue;
    const time = Number(message.ts) * 1000;
    if (!/^\d+\.\d+$/.test(message.ts) || !Number.isFinite(time) || time <= 0 || time > 8640000000000000) throw new Error('Slack: Fehlermeldung ohne gültige Nachrichten-ID.');
    const lauf = value?.kind === 'lauf';
    // KOR-10: the worker rewrote this copy for a withdrawn order; no open error.
    if (lauf && value.state === WITHDRAWN_RUN_STATE) continue;
    const text = String(message.text || '');
    const jobId = String(value?.task_id || '');
    const { kind, taskId, sourceId, workflow } = errorJob(jobId, lauf);
    const source = tasks.find(task => task.id === sourceId);
    const taskLink = /<(https:\/\/app\.clickup\.com\/t\/[A-Za-z0-9_-]+)\|([^>]+)>/.exec(text);
    // Existing worker copies contain a permalink to their original channel.
    const workspace = /https:\/\/([a-z0-9-]+\.slack\.com)\/archives\//i.exec(text)?.[1] || 'app.slack.com';
    const errorUrl = `https://${workspace}/archives/${encodeURIComponent(channelId)}/p${message.ts.replace('.', '')}`;
    const body = text.split('\n').slice(1).join('\n').replace(/^(.*?[Bb]lockiert:)\s*<https:\/\/app\.clickup\.com\/t\/[^>]+>[^\n]*\n/u, '$1\n');
    const diagnosis = issue?.message || parseBlockedReason(body) || 'Offene Fehlermeldung in #ai-fehler';
    const company = displayText(slackText(text.split('\n')[0]).replace(/[*`]/g, '').split(' · ').slice(1).join(' · '), 200);
    const id = `slack-error:${channelId}:${message.ts}`;
    const updatedAt = new Date(time).toISOString();
    if (!(kind === 'upload' && manualUploadIds.has(taskId))) {
      rows.set(id, { ...source, id, status: 'blocked', workflow,
        title: displayText(slackText(taskLink?.[2] || source?.title || (issue ? `Worker · ${issue.workerId} · ${issue.stage}` : text.split('\n')[0])), 300, 'Fehler in #ai-fehler'),
        url: taskLink?.[1] || source?.url, errorUrl,
        company: source?.company || company, workerId: value?.worker || issue?.workerId,
        phase: 'Offen in #ai-fehler', blockedReason: diagnosis, attemptId: value?.run_id,
        progress: undefined, updatedAt });
    }
    if (!lauf) continue;
    for (const { job, attemptId } of causeJobs(value, jobId, id)) {
      const other = errorJob(job, true);
      if (other.kind === 'upload' && manualUploadIds.has(other.taskId)) continue;
      const row = tasks.find(task => task.id === other.sourceId);
      rows.set(`${id}#${job}`, { ...row, id: `${id}#${job}`, status: 'blocked', workflow: other.workflow,
        title: displayText(row?.title || job, 300, 'Fehler in #ai-fehler'),
        url: row?.url || `https://app.clickup.com/t/${encodeURIComponent(other.taskId)}`, errorUrl,
        company: row?.company || company, workerId: value.worker,
        phase: 'Offen in #ai-fehler', blockedReason: diagnosis, attemptId,
        progress: undefined, updatedAt });
    }
  }
  return [...rows.values()];
}

function taskDate(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function figmaLink(value) {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['figma.com', 'www.figma.com'].includes(url.hostname)
      && !url.username && !url.password && /^\/(design|file|proto|board)\/[^/]+/.test(url.pathname)) return url.href;
  } catch { /* An optional task link must not interrupt queue synchronization. */ }
  return undefined;
}

function taskFigmaLink(task) {
  const fields = Array.isArray(task.custom_fields) ? task.custom_fields.filter(field => field && typeof field === 'object') : [];
  const candidates = [
    fields.find(field => field.id === 'ef2ba681-7e9d-40a3-b79a-dda5cd402015'),
    fields.find(field => field.id === '3530f8a4-44e1-4ea5-894d-4d87fb5c418d'),
    ...fields.filter(field => field.type === 'url' && /^figma(?:[ _-]+(?:link|board))?$/i.test(field.name || '')),
  ];
  for (const field of candidates) {
    const url = figmaLink(field?.value);
    if (url) return url;
  }
  return undefined;
}

export function contentKind(task, claims = []) {
  const name = `${task.name || ''} ${task.list?.name || ''}`;
  if (/pop[ -]?up/i.test(name)) return 'popup';
  const flow = (task.custom_fields || []).some(field => /flow.*type/i.test(field.name || '')
    && field.value !== null && field.value !== undefined && field.value !== '');
  if (flow || /\bflows?\b/i.test(task.name || '')
    || (/\bflows?\b/i.test(task.list?.name || '') && !/newsletter/i.test(task.list?.name || '')))
    return 'flow';
  if (claims.some(claim => claim.channelId === 'C0C8FQMKW3B' || claim.channelId === 'C0C8FQNUZKK')) return 'flow';
  if (claims.some(claim => claim.channelId === 'C0C8DMEKJQJ')) return 'popup';
  return 'newsletter';
}

export function completionEvidence(claims) {
  const latest = claims.filter(claim => claim.state !== 'withdrawn')
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  if (!latest || latest.completionTimestampKnown === false || !['final', 'released'].includes(latest.state) || latest.outcome !== 'completed') return {};
  const time = Number(latest.heartbeat) * 1000;
  if (!Number.isFinite(time) || time <= 0) return {};
  return { completedAt: new Date(time).toISOString(), completionSource: 'slack' };
}

// A later terminal attempt retires older reservations, including portable pauses.
// Within the current attempt generation the worker's earliest-live-owner rule stays.
export function selectCurrentClaim(matches, now, staleMinutes = 30) {
  const ordered = matches.filter(claim => claim.state !== 'withdrawn').sort((a, b) => compareSlackTs(b.ts, a.ts));
  const terminal = ordered.find(claim => ['final', 'released'].includes(claim.state));
  const active = ordered.filter(claim => ['claiming', 'running'].includes(claim.state)
    && (!terminal || compareSlackTs(claim.ts, terminal.ts) > 0))
    .sort((a, b) => Number(Boolean(a.paused && a.portable)) - Number(Boolean(b.paused && b.portable)) || compareSlackTs(a.ts, b.ts));
  return active.find(claim => now - claim.heartbeat * 1000 <= staleMinutes * 60000) || active[0]
    || (terminal?.state === 'final' || terminal?.outcome === 'completed' ? terminal : undefined);
}

export function retainCompletionDates(rows, previousTasks = [], claims = []) {
  const previousById = new Map(previousTasks.map(task => [task.id, task]));
  for (const row of rows) {
    const previous = previousById.get(row.id);
    if (row.status !== 'completed' || row.completedAt || previous?.status !== 'completed'
      || previous.completionSource !== 'slack' || !previous.completedAt) continue;
    const workflow = row.workflow === 'upload' ? 'klaviyo' : row.workflow === 'translation' ? row.id.split(':')[1] : row.workflow;
    const taskId = row.id.split(':').at(-1);
    if (!claims.some(claim => claim.taskId === taskId && claim.workflow === workflow))
      Object.assign(row, { completedAt: previous.completedAt, completionSource: previous.completionSource });
  }
  return rows;
}

// Keep language steps attached to their source task. A different ClickUp task
// belongs to the package only with an explicit briefing link and source identity.
function languagePackage(task, tasks, workflow) {
  if (!["newsletter", "translation"].includes(workflow.queueWorkflow || workflow.id)) return {};
  const prefix = /^\s*\[?(DE|EN|IT|FR|SE|SP)\]?(?:\s*[|¦:]\s*|\s+[-–—·]\s+)(?=\S)/u;
  const language = /^translation-([a-z]{2})$/.exec(workflow.id)?.[1] || prefix.exec(task.name || "")?.[1].toLowerCase();
  const core = name => String(name || "").replace(prefix, "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const text = [task.markdown_description, task.description, task.text_content].filter(Boolean).join("\n");
  const links = [...text.matchAll(/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9]+)/g)].map(match => match[1]);
  const sources = language && language !== "de" ? tasks.filter(source => source.id !== task.id && links.includes(source.id)
    && task.folder?.id && source.folder?.id === task.folder.id
    && (prefix.exec(source.name || "")?.[1] === "DE" || (!prefix.test(source.name || "") && core(source.name) === core(task.name)))) : [];
  return { packageId: sources.length === 1 ? sources[0].id : task.id, language };
}

function taskUrl(task) {
  try {
    const candidate = new URL(task.url);
    if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && String(task.url).length <= 2000) return candidate.href;
  } catch { /* Use the canonical ClickUp task link. */ }
  return `https://app.clickup.com/t/${encodeURIComponent(task.id)}`;
}

// A Mac whose own heartbeat reached the RS Hub this recently is alive (the
// worker heartbeat's validity, docs/fleet-monitoring.md: 180 s).
export const FLEET_FRESH_MS = 180000;
// How long a live Mac's reservation may lag behind before it counts as silent.
export const RESERVATION_LAG_MS = 2 * 3600000;
export const RESERVATION_LAG_PHASE = 'Wartet · Mac aktiv, Reservierungsmeldung an den RS Hub verzögert';

// D11-M2 (Fehleraudit 17.10.2026): a live reservation whose own heartbeat is stale
// while its Mac's fleet heartbeat is fresh. The Mac works; only the reservation
// sync lags (Hub transport, Slack update limits). It waits and is not blocked.
// A reservation silent for longer than RESERVATION_LAG_MS stays blocked.
function reservationLags(claim, seenAt, now) {
  const seen = seenAt.get(claim?.workerId);
  const macAge = now - seen, claimAge = now - claim?.heartbeat * 1000;
  return Number.isFinite(macAge) && macAge >= -30000 && macAge <= FLEET_FRESH_MS
    && Number.isFinite(claimAge) && claimAge <= RESERVATION_LAG_MS;
}

function fleetSeen(workers) {
  const seen = new Map();
  for (const worker of Array.isArray(workers) ? workers : []) {
    const at = Date.parse(worker?.lastSeenAt);
    if (typeof worker?.workerId === 'string' && Number.isFinite(at) && !(seen.get(worker.workerId) >= at)) seen.set(worker.workerId, at);
  }
  return seen;
}

// tasks may carry statusSince (the worker's status epoch, readStatusEpochs).
// admission: the worker's admission predicates (workerAdmission, loadWorkerAdmission).
// workers: the Macs' heartbeats read from the RS Hub (parseObservedWorkers).
export function buildQueue(tasks, claims, workflows, { now = Date.now(), staleMinutes = 30, figmaBoardUrl, admission = workerAdmission(), workers } = {}) {
  const updatedAt = new Date(now).toISOString();
  const seenAt = fleetSeen(workers);
  const rows = [];
  for (const task of tasks) {
    const tags = task.tags.map(tag => typeof tag === 'string' ? tag : String(tag?.name ?? ''));
    const sourceStatus = normalizeStatus(taskStatus(task));
    for (const workflow of workflows) {
      const starts = (workflow.startStatuses ?? []).map(normalizeStatus);
      // Like the worker: the start status is the order, a tag never is.
      const ordered = starts.includes(sourceStatus);
      if (!ordered && !workflowMatches(workflow, tags)) continue;
      const normalized = new Set(tags.map(normalizeTag));
      let status = 'queued';
      for (const name of ['queued', 'running', 'failed', 'blocked', 'completed']) {
        if ((workflow.stateTags?.[name] ?? []).some(tag => normalized.has(normalizeTag(tag)))) status = name;
      }
      if ((workflow.claimWorkflow ?? workflow.id) === 'klaviyo' && admission.manualUpload(task) && status !== 'completed') continue;
      // In its start status only reservations of the current order (same epoch as
      // the worker's job ID) describe it. A live older attempt still holds its place
      // and a paused one bound to its Mac still blocks the order; a centrally saved
      // (portable) pause of an older epoch no longer describes it (F29, Till 16.10.2026).
      const matches = claims.filter(claim => claim.taskId === task.id && claim.workflow === (workflow.claimWorkflow ?? workflow.id)
        && !(ordered && task.statusSince && (!LIVE_CLAIM_STATES.has(claim.state) || (claim.paused && claim.portable))
          && jobIdentity(claim.jobId).epoch && jobIdentity(claim.jobId).epoch !== String(task.statusSince)));
      const claim = selectCurrentClaim(matches, now, staleMinutes);
      const active = claim && ['claiming', 'running'].includes(claim.state) ? [claim] : [];
      const fresh = active.find(claim => now - claim.heartbeat * 1000 <= staleMinutes * 60000);
      const pausedTag = tags.some(name => / · pausiert$/i.test(name) && Object.values(workflow.stateTags || {}).flat().some(tag => normalizeTag(tag) === normalizeTag(name)));
      let phase;
      if (pausedTag && !fresh) { status = 'queued'; phase = 'Wartet · automatische Fortsetzung'; }
      if ((!pausedTag || fresh) && status !== 'completed' && status !== 'failed' && status !== 'blocked') {
        if (fresh) { status = fresh.state === 'running' ? 'running' : 'queued'; phase = fresh.state === 'running' ? 'In Bearbeitung' : 'Reserviert'; }
        else if (active.length && reservationLags(active[0], seenAt, now)) { status = 'queued'; phase = RESERVATION_LAG_PHASE; }
        else if (active.length) { status = 'blocked'; phase = 'Worker meldet sich nicht mehr'; }
        else if (status === 'running') { phase = 'Läuft laut ClickUp; Worker-Zuordnung fehlt'; }
      }
      if (pausedTag && fresh) phase = 'Pausiert · automatische Fortsetzung';
      if (!['completed', 'blocked', 'failed'].includes(status) && claim?.outcome !== 'completed' && claim?.paused === true && ['claiming', 'running'].includes(claim.state)) { status = 'queued'; phase = 'Pausiert · wartet außerhalb der Worker-Plätze'; }
      if (!['completed', 'blocked', 'failed'].includes(status) && claim?.outcome !== 'completed' && claim?.paused && claim.portable) { status='queued'; phase='Wartet · Fortsetzung in der zentralen Queue'; }
      if (status === 'blocked' && !phase) phase = 'Blockiert';
      // Waiting or running without a reservation is an order only in the start
      // status, and never for an order the worker's admit() parks (manual, pop-up,
      // test workspace, cutover). Blocked and completed history and reserved runs
      // stay; downstream Pre-Gen statuses complete it below.
      const backed = Boolean(claim) && claim.outcome !== 'completed' && (LIVE_CLAIM_STATES.has(claim.state) || claim.paused === true);
      if (workflow.reservationOnly && ['queued', 'running'].includes(status) && !backed) continue;
      if (starts.length && ['queued', 'running'].includes(status) && !backed
        && ((!ordered && !taskState.preGenFinished({ workflow: workflow.queueWorkflow ?? workflow.id, sourceStatus: taskStatus(task) }))
          || (ordered && admission.parked(task, statusKindOf(task), task.statusSince)))) continue;
      if (ordered && !backed && status === 'queued' && !phase) phase = refusedPhase(task);
      const url = taskUrl(task);
      const name = displayText(task.name, 300, task.id);
      const title = workflow.titleSuffix ? `${displayText(name, 300 - workflow.titleSuffix.length - 3)} · ${workflow.titleSuffix}` : name;
      const evidence = status === 'completed' ? completionEvidence(matches) : {};
      rows.push({ id: `clickup:${workflow.id}:${task.id}`, title, url, workflow: workflow.queueWorkflow ?? workflow.id, status,
        ...languagePackage(task, tasks, workflow),
        contentKind: contentKind(task, matches),
        ...evidence,
        completionSource: evidence.completionSource || (status === 'completed' ? 'clickup' : undefined),
        sourceStatus: displayText(typeof task.status === 'string' ? task.status : task.status?.status, 120),
        company: task.folder?.hidden ? undefined : displayText(task.folder?.name, 200),
        figmaUrl: taskFigmaLink(task) || ((workflow.claimWorkflow ?? workflow.id) === 'newsletter' ? figmaLink(figmaBoardUrl) : undefined),
        workerId: claim?.paused && claim.portable ? undefined : claim?.workerId, attemptId: claim?.runId, phase: displayText(phase, 160), progress: status === 'completed' ? 100 : undefined,
        updatedAt: taskDate(task.date_updated, updatedAt), tags: [...new Set(tags.map(tag => displayText(tag, 80)).filter(Boolean))].slice(0, 30),
        // Internal only: addRunDetails reads progress and renders of this attempt, then removes it.
        run: claim ? { id: claim.runId, jobId: claim.jobId, workerId: claim.workerId, ts: threadOf(claim), taskId: task.id, channelId: claim.channelId, heartbeat: threadBeat(claim) } : undefined });
    }
  }
  // Revisions come from the approval workflow. They can run while the old
  // Pre-Gen task remains completed and must be visible independently of its tags.
  const corrections = new Map();
  for (const claim of claims.filter(claim => claim.workflow === 'correction' && claim.state !== 'withdrawn')) {
    if (!corrections.has(claim.jobId)) corrections.set(claim.jobId, []);
    corrections.get(claim.jobId).push(claim);
  }
  for (const attempts of corrections.values()) {
    const claim = selectCurrentClaim(attempts, now, staleMinutes);
    if (!claim) continue;
    if (claim.state === 'released' && claim.outcome !== 'completed') continue;
    const active = ['claiming', 'running'].includes(claim.state);
    const fresh = now - claim.heartbeat * 1000 <= staleMinutes * 60000;
    const lagging = active && !fresh && reservationLags(claim, seenAt, now);
    const paused = claim.paused && claim.outcome !== 'completed';
    const status = paused ? 'queued' : active ? fresh ? claim.state === 'running' ? 'running' : 'queued' : lagging ? 'queued' : 'blocked' : claim.outcome || 'blocked';
    const phase = paused && claim.portable ? 'Wartet · Fortsetzung in der zentralen Queue' : paused ? active ? 'Pausiert · wartet außerhalb der Worker-Plätze' : 'Wartet · automatische Fortsetzung' : active ? fresh ? claim.state === 'running' ? 'Korrektur in Bearbeitung' : 'Korrektur reserviert' : lagging ? RESERVATION_LAG_PHASE : 'Worker meldet sich nicht mehr'
      : status === 'completed' ? 'Korrektur abgeschlossen' : claim.awaitingPm ? 'PM-Rückfrage offen'
        : claim.outcome === 'blocked' ? 'Korrektur blockiert' : 'Korrekturabschluss noch nicht bestätigt';
    const task = tasks.find(task => task.id === claim.taskId);
    rows.push({ id: `correction:${claim.jobId}`, title: displayText(claim.title || task?.name, 300, `Korrektur ${claim.taskId}`),
      url: claim.url || (claim.taskId !== claim.jobId ? `https://app.clickup.com/t/${encodeURIComponent(claim.taskId)}` : undefined), workflow: 'correction',
      company: claim.company === 'Korrektur' ? undefined : claim.company, status, workerId: claim.paused && claim.portable ? undefined : claim.workerId, attemptId: claim.runId,
      phase, progress: status === 'completed' ? 100 : undefined, updatedAt: new Date(claim.heartbeat * 1000).toISOString(),
      ...completionEvidence([claim]),
      run: { id: claim.runId, jobId: claim.jobId, workerId: claim.workerId, ts: threadOf(claim), taskId: claim.taskId, channelId: claim.channelId, heartbeat: threadBeat(claim) } });
  }
  rows.push(...waitingCorrections(tasks, rows, updatedAt, admission));
  return rows.map(taskState.reconcileTask).sort((a, b) => a.id.localeCompare(b.id));
}

// Slack parent of a reservation; a register-only reservation may have none yet.
function threadOf(claim) {
  return claim.threadTs === undefined ? claim.ts : claim.threadTs;
}

// Re-read key of that thread (readRunStatuses): the Slack post's heartbeat. The
// register renews its own on every worker sync, which would re-read every cycle.
function threadBeat(claim) {
  return claim.threadHeartbeat === undefined ? claim.heartbeat : claim.threadHeartbeat;
}

// A task in revision intern/extern is a correction order like in the worker,
// with its job ID korrektur-cu-<id>@<since>-<origin>. A reservation of that
// exact order (also per file) shows it; older rounds never hide a new one.
function waitingCorrections(tasks, rows, updatedAt, admission) {
  const attempts = rows.filter(row => row.workflow === 'correction' && row.run).map(row => ({ row, job: CORRECTION_JOB.exec(row.run.jobId) })).filter(entry => entry.job);
  const waiting = [];
  for (const task of tasks) {
    const origin = CORRECTION_STATUSES[normalizeStatus(taskStatus(task))];
    if (!origin) continue;
    const tags = task.tags.map(tag => typeof tag === 'string' ? tag : String(tag?.name ?? ''));
    const normalized = new Set(tags.map(normalizeTag));
    const since = task.statusSince ? String(task.statusSince) : undefined;
    // Orders the worker parks (clickup-source.js admit()); nobody will reserve them.
    if (admission.parked(task, 'korrektur', since)) continue;
    // Without an epoch only an unfinished attempt of the same origin covers the task.
    if (attempts.some(({ row, job }) => job[1] === task.id && job[3] === origin && (since ? job[2] === since : row.status !== 'completed'))) continue;
    const has = name => normalized.has(normalizeTag(name));
    const [status, phase] = has('revision · blockiert') ? ['blocked', 'Korrektur blockiert']
      : has('revision · rückfrage slack') ? ['queued', 'Wartet · PM-Rückfrage']
        : has('revision · läuft') ? ['running', 'Läuft laut ClickUp; Worker-Zuordnung fehlt'] : ['queued', refusedPhase(task)];
    waiting.push({ id: `correction:korrektur-cu-${task.id}${since ? `@${since}` : ''}-${origin}`, title: displayText(task.name, 300, task.id),
      url: taskUrl(task), workflow: 'correction', status, phase,
      sourceStatus: displayText(taskStatus(task), 120), company: task.folder?.hidden ? undefined : displayText(task.folder?.name, 200),
      updatedAt: taskDate(task.date_updated, updatedAt), tags: [...new Set(tags.map(tag => displayText(tag, 80)).filter(Boolean))].slice(0, 30) });
  }
  return waiting;
}

// AI Newsletter Creation src/slack-notifier.js statusText(): the worker posts one
// reply in the claim thread and edits it every 5 minutes, e.g.
// ":hourglass_flowing_sand: 50 % · Bau der Mail\n_Stand 17:31 · …_" (paused: ⏸️ … · pausiert: …).
export function parseRunStatus(text) {
  const line = String(text ?? '').split('\n')[0];
  const match = /^(?:⏳|⏸️?|:hourglass(?:_flowing_sand)?:|:double_vertical_bar:|:pause_button:)\s*(\d{1,3})\s*%\s*·\s*(.+)$/u.exec(line);
  if (!match || Number(match[1]) > 100) return null;
  const step = displayText(match[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), 160);
  return step ? { percent: Number(match[1]), step } : null;
}

export function parseBlockedReason(text) {
  const value = String(text ?? '').replace(/[*`]/g, '');
  if (!/^(?:⛔|⚠️?|:warning:|:no_entry:).*?(?:Blockiert|blockiert)/u.test(value)) return null;
  const detail = /(?:^|\n|\.\s+)Grund:?\s*([\s\S]+)/.exec(value)?.[1] || value.replace(/^.*?(?:Blockiert|blockiert):?\s*/u, '');
  return displayText(detail.split(/\n(?:_?Stand |:stopwatch:|⏱|Dauer |Entwurf:|<https:\/\/[a-z0-9-]+\.slack\.com\/archives\/)/)[0]
    .replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/\s+at \w[^\n]*$/, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[ENTFERNT]')
    .replace(/\b(?:xox[abposr]-|sk-|gh[opsu]_)[A-Za-z0-9_-]+/g, '[ENTFERNT]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [ENTFERNT]')
    .replace(/((?:api[_-]?key|token|secret|password|passwort)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[ENTFERNT]')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), 500) || null;
}

function parsePmQuestion(text) {
  const lines = String(text ?? '').split('\n');
  if (!/^\*?Unklar\s*[–—-]\s*bitte hier antworten\*?/.test(lines[0])) return null;
  const questions = lines.slice(1).map(line => /^\s*•\s*Unklar\s*·\s*Kommentar\s+\d+\s*\(.*?\):\s*(.+)$/.exec(line)?.[1]).filter(Boolean);
  return questions.length ? parseBlockedReason(`:warning: blockiert: ${questions.join(' · ')}`) : null;
}

export function parseWaitingReason(text) {
  const lines = String(text ?? '').split('\n');
  if (!/^(?:⏸️?|:double_vertical_bar:) Pausiert · automatische Fortsetzung über die Queue\s*$/.test(lines[0])) return null;
  return parseBlockedReason(':warning: blockiert: ' + lines.slice(1).join('\n'));
}

export const RUN_STATUS_MAX_AGE_MS = 300000;

// threads: ts strings or { ts, heartbeat }. With a cache (per channel and ts), a
// thread is read again only when its claim heartbeat changed or its status is
// 5 min old. The first 429 (budget.limited, shared per cycle) stops all further
// reads; unread threads keep their last known status for the display.
export async function readRunStatuses(hubFetch, channelId, threads, { concurrency = 4, cache, now = Date.now(), budget = { limited: false } } = {}) {
  const wanted = new Map();
  for (const thread of threads) {
    const ts = typeof thread === 'string' ? thread : thread?.ts;
    if (typeof ts === 'string' && !wanted.has(ts)) wanted.set(ts, typeof thread === 'string' ? undefined : thread.heartbeat);
  }
  const statuses = new Map();
  const known = ts => { const status = cache?.get(`${channelId}:${ts}`)?.status; if (status) statuses.set(ts, status); };
  const pending = [];
  for (const [ts, heartbeat] of wanted) {
    const old = cache?.get(`${channelId}:${ts}`);
    const age = old ? now - old.at : NaN;
    if (old && old.heartbeat === heartbeat && age >= 0 && age < RUN_STATUS_MAX_AGE_MS) known(ts);
    else pending.push(ts);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (pending.length && !budget.limited) {
      const ts = pending.shift();
      try {
        const url = new URL('https://slack.com/api/conversations.replies');
        for (const [key, value] of Object.entries({ channel: channelId, ts, limit: 50 })) url.searchParams.set(key, String(value));
        const result = await requestJson(hubFetch, url, 'Slack');
        // Only the worker's own bot reply counts, never a person writing in the thread.
        const found = (Array.isArray(result.messages) ? result.messages : [])
          .filter(message => message?.ts !== ts && message?.bot_id).map(message => parseRunStatus(message.text)
            || (parsePmQuestion(message.text) ? { pmQuestion: parsePmQuestion(message.text) } : null)
            || (parseWaitingReason(message.text) ? { blockedReason: parseWaitingReason(message.text) } : null)
            || (parseBlockedReason(message.text) ? { blockedReason: parseBlockedReason(message.text) } : null)).filter(Boolean);
        if (found.length) statuses.set(ts, found.at(-1));
        cache?.set(`${channelId}:${ts}`, { heartbeat: wanted.get(ts), at: now, status: found.at(-1) || null });
      } catch (error) {
        // Progress is optional: the task simply stays "In Bearbeitung".
        if (isRateLimited(error)) budget.limited = true;
        known(ts);
      }
    }
  }));
  for (const ts of pending) known(ts);
  return statuses;
}

const RENDER_ASSET = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:png|jpg|gif|webp)$/;
const CUSTOMER_ID = /^[a-z0-9_-]{1,64}$/i;

// RS Hub customer intelligence (RS-Hub lib/customer-intelligence/schema.js):
// build.py --kunde stores every actual render, including the first one before the
// Art Director, as a deliverable of the mail's message. A task's messages carry
// external_id "clickup:<task>:<master|mail-N>", each render metadata.attemptId = run_id.
export function readRenders(db, attempts) {
  const messages = db.prepare('SELECT customer_id, id, title FROM messages WHERE external_id >= ? AND external_id < ? ORDER BY created_at, external_id');
  const renders = db.prepare(`SELECT created_at, json_extract(content, '$.render.id') AS render_id, json_extract(content, '$.render.sha256') AS sha256,
    json_extract(content, '$.subject') AS subject FROM deliverables WHERE customer_id = ? AND message_id = ?
    AND json_extract(metadata, '$.attemptId') = ? AND json_extract(content, '$.render.id') IS NOT NULL ORDER BY created_at, version`);
  const result = new Map();
  for (const { taskId, runId } of attempts) {
    const mails = [];
    for (const message of messages.all(`clickup:${taskId}:`, `clickup:${taskId};`)) {
      const rows = renders.all(message.customer_id, message.id, runId);
      const latest = rows.at(-1);
      if (!latest) continue;
      mails.push({ key: message.id, customerId: message.customer_id, renderId: latest.render_id, sha256: String(latest.sha256 || latest.render_id),
        title: displayText(message.title, 200, 'Mail'), subject: displayText(latest.subject, 300), renderedAt: latest.created_at, render: rows.length });
    }
    if (mails.length) result.set(runId, mails.slice(0, MAX_PREVIEWS_PER_TASK));
  }
  return result;
}

export async function resizeRender(sharp, buffer) {
  // Smaller fallbacks keep very tall mails below the relay's upload limit.
  for (const [width, quality] of [[PREVIEW_WIDTH, 74], [PREVIEW_WIDTH, 60], [480, 60]]) {
    const { data, info } = await sharp(buffer, { limitInputPixels: 33554432, failOn: 'error' }).timeout({ seconds: 20 })
      .resize({ width, withoutEnlargement: true }).flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (data.length <= MAX_PREVIEW_UPLOAD_BYTES) return { data, width: info.width, height: info.height };
  }
  throw new Error('Vorschau bleibt über dem Upload-Limit.');
}

// Runs on the Hub only (read-only access to the local RS Hub). Each render is
// resized and uploaded once; a failure keeps showing that mail's previous picture.
export function createRenderPreviews({ localHub, upload, openDatabase, resize, readFile = fs.readFile, perCycle = PREVIEWS_PER_CYCLE }) {
  const databaseFile = path.join(localHub, 'data', 'customer-intelligence.sqlite');
  const assets = path.join(localHub, 'data', 'customer-intelligence', 'assets');
  let made = new Map();
  let shown = new Map();
  return async attempts => {
    const db = openDatabase(databaseFile);
    let renders;
    try { renders = readRenders(db, attempts); } finally { db.close(); }
    const nextMade = new Map();
    const nextShown = new Map();
    const result = new Map();
    let budget = perCycle;
    for (const [runId, mails] of renders) {
      const list = [];
      for (const mail of mails) {
        let image = made.get(mail.sha256);
        if (!image && budget > 0 && CUSTOMER_ID.test(mail.customerId) && RENDER_ASSET.test(mail.renderId || '')) {
          budget -= 1;
          try {
            const { data, width, height } = await resize(await readFile(path.join(assets, mail.customerId, mail.renderId)));
            const id = crypto.createHash('sha256').update(data).digest('hex');
            await upload(id, data);
            image = { id, width, height };
          } catch { /* Retried next cycle; meanwhile the previous picture stays. */ }
        }
        const key = `${runId}:${mail.key}`;
        const entry = image ? { id: image.id, title: mail.title, ...(mail.subject ? { subject: mail.subject } : {}),
          renderedAt: new Date(mail.renderedAt).toISOString(), render: mail.render, width: image.width, height: image.height } : shown.get(key);
        if (image) nextMade.set(mail.sha256, image);
        if (entry) { nextShown.set(key, entry); list.push(entry); }
      }
      if (list.length) result.set(runId, list);
    }
    made = nextMade;
    shown = nextShown;
    return result;
  };
}

// Live step from Slack for running work; render previews for newsletter attempts.
// Pictures stay after completion (refreshed once at the transition) and are never
// backfilled for tasks that finished before this monitor saw them run.
export async function addRunDetails(rows, { hubFetch, channelId, previews, previousTasks = [], now = Date.now(), statusCache }) {
  const previous = new Map((Array.isArray(previousTasks) ? previousTasks : []).map(row => [row?.id, row]));
  const waiting = row => row.status === 'queued' && /^Wartet · (?:Hub-Übergabe|Fortsetzung in der zentralen Queue|automatische Fortsetzung)$/.test(row.phase || '');
  const running = rows.filter(row => row.run && (row.status === 'running' || ((row.status === 'blocked' || waiting(row)) && row.workflow === 'correction'
    && !(previous.get(row.id)?.attemptId === row.attemptId && previous.get(row.id)?.blockedReason))));
  const attempts = rows.filter(row => row.run && row.workflow === 'newsletter' && (['running', 'blocked'].includes(row.status)
    || (row.status === 'completed' && ['running', 'blocked'].includes(previous.get(row.id)?.status))));
  const channels = new Map();
  for (const row of running) {
    const channel = row.run.channelId || channelId;
    if (!channels.has(channel)) channels.set(channel, []);
    channels.get(channel).push({ ts: row.run.ts, heartbeat: row.run.heartbeat });
  }
  const budget = { limited: false };
  const [statusLists, rendered] = await Promise.all([
    Promise.all([...channels].map(async ([channel, threads]) => [channel, await readRunStatuses(hubFetch, channel, threads, { cache: statusCache, now, budget })])),
    previews && attempts.length ? previews(attempts.map(row => ({ taskId: row.run.taskId, runId: row.run.id }))).catch(() => null) : new Map(),
  ]);
  if (statusCache) {
    const live = new Set(running.map(row => `${row.run.channelId || channelId}:${row.run.ts}`));
    for (const key of [...statusCache.keys()]) if (!live.has(key)) statusCache.delete(key);
  }
  const statuses = new Map(statusLists);
  for (const row of rows) {
    const old = previous.get(row.id);
    const status = statuses.get(row.run?.channelId || channelId)?.get(row.run?.ts);
    if (row.status === 'running' && status?.percent !== undefined) { row.progress = status.percent; row.step = status.step; }
    if ((row.status === 'blocked' || waiting(row)) && row.workflow === 'correction') {
      row.blockedReason = status?.pmQuestion || status?.blockedReason || (old?.attemptId === row.attemptId && old.blockedReason
        ? parseBlockedReason(`:warning: blockiert: ${old.blockedReason}`) : undefined);
      if (status?.pmQuestion || row.phase === 'PM-Rückfrage offen'
        || (old?.attemptId === row.attemptId && old.phase === 'PM-Rückfrage offen' && row.blockedReason)) row.phase = 'PM-Rückfrage offen';
      else if (row.blockedReason && row.status === 'blocked') row.phase = 'Korrektur blockiert';
    }
    const list = attempts.includes(row) ? (rendered ? rendered.get(row.run.id) : old?.previews)
      : row.status === 'completed' && old?.status === 'completed' ? old.previews : undefined;
    const kept = Array.isArray(list) ? list.filter(entry => now - Date.parse(entry?.renderedAt) <= PREVIEW_RETENTION_MS) : [];
    if (kept.length) row.previews = kept;
    delete row.run;
  }
  return rows;
}

const placeCount = value => Number.isInteger(value) && value >= 0 && value <= 50 ? value : undefined;

// Places per kind exactly as the worker heartbeat bounds them (hub-transport.js validPlaetze).
function parsePlaces(value) {
  const kinds = ['newsletter', 'klaviyo', 'translation'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(kind => ![...kinds, 'korrektur'].includes(kind))
    || [...kinds, ...(Object.hasOwn(value, 'korrektur') ? ['korrektur'] : [])].some(kind => placeCount(value[kind]) === undefined)) return undefined;
  return Object.fromEntries(Object.keys(value).sort().map(kind => [kind, value[kind]]));
}

// occupied_tasks is the worker's own admission count (src/mac-capacity.js: runs
// of both workspaces, Sales receipts, browser jobs, previews, transfers; paused
// work excluded). max_tasks is its own maximum; until a worker sends it, the
// worker table of the installed source (maxTasksOf) supplies the same value.
export function parseObservedWorkers(values, { maxTasksOf } = {}) {
  if (!Array.isArray(values)) throw new Error('Hub: Worker-Liste ungültig.');
  const byId = new Map();
  for (const value of values) {
    if (!value || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.worker_id) || !Number.isFinite(Date.parse(value.seen_at))) continue;
    const worker = { workerId: value.worker_id, name: value.worker_id, lastSeenAt: new Date(value.seen_at).toISOString(),
      workerVersion: displayText(value.worker_version, 80), workerRevision: displayText(value.worker_revision, 80),
      pendingClickup: Number.isInteger(value.pending_clickup) && value.pending_clickup >= 0 && value.pending_clickup <= 100000 ? value.pending_clickup : undefined };
    if (typeof value.annahme === 'boolean') worker.acceptingTasks = value.annahme;
    const occupied = placeCount(value.occupied_tasks);
    let maximum = placeCount(value.max_tasks);
    if (maximum === undefined && typeof maxTasksOf === 'function') { try { maximum = placeCount(maxTasksOf(value.worker_id)); } catch { /* No table, no maximum. */ } }
    const places = parsePlaces(value.plaetze);
    if (occupied !== undefined) worker.occupiedTasks = occupied;
    if (maximum !== undefined) worker.maxTasks = maximum;
    if (places) worker.places = places;
    if (!byId.has(worker.workerId) || Date.parse(worker.lastSeenAt) > Date.parse(byId.get(worker.workerId).lastSeenAt)) byId.set(worker.workerId, worker);
  }
  return [...byId.values()];
}

export async function readHubFleet(hub, { spawnImpl = spawn, fleetDirectory = path.join(hub.hub_dir, 'logs', 'ai-newsletter-fleet'), maxTasksOf } = {}) {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(hub.ssh_host) || !/^\/[A-Za-z0-9._/-]+$/.test(fleetDirectory)) throw new Error('Hub: SSH-Konfiguration ungültig.');
  const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const args = ['-i', expand(hub.identity_file), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${expand(hub.known_hosts_file)}"`,
    '-o', 'ConnectTimeout=15', '-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(os.homedir(), '.ssh', 'cm-ainl-%C')}`,
    '-o', 'ControlPersist=120', hub.ssh_host, 'node -'];
  // Fixed read-only program; no remote paths, credentials or file content are returned except telemetry allowlist.
  const program = `const fs=require('fs'),path=require('path');const dir=${JSON.stringify(fleetDirectory)};const rows=[];
    for(const name of fs.readdirSync(dir)){if(!/^[a-z0-9][a-z0-9._-]{0,79}\\.json$/i.test(name))continue;
      const file=path.join(dir,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>16384)continue;
      try{const v=JSON.parse(fs.readFileSync(file,'utf8'));rows.push({worker_id:v.worker_id,seen_at:v.seen_at,worker_version:v.worker_version,worker_revision:v.worker_revision,pending_clickup:v.pending_clickup,annahme:v.annahme,occupied_tasks:v.occupied_tasks,max_tasks:v.max_tasks,plaetze:v.plaetze});}catch{}}
    process.stdout.write(JSON.stringify(rows));`;
  const output = await new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Hub: Worker-Abfrage hat das Zeitlimit erreicht.')); }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1048576) { child.kill('SIGKILL'); finish(new Error('Hub: Worker-Antwort zu groß.')); } });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('Hub: SSH nicht verfügbar.')));
    child.once('close', code => finish(code === 0 ? null : new Error('Hub: Worker-Dateien nicht lesbar.'), stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(program);
  });
  return parseObservedWorkers(JSON.parse(output), { maxTasksOf });
}

export async function readLocalHubFleet(hub, { fleetDirectory = path.join(hub.hub_dir, 'logs', 'ai-newsletter-fleet'), maxTasksOf } = {}) {
  const names = await fs.readdir(fleetDirectory);
  if (names.length > 5000) throw new Error('Hub: zu viele Worker-Dateien.');
  const rows = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}\.json$/i.test(name)) continue;
    const file = path.join(fleetDirectory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 16384) continue;
    try { rows.push(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { /* A broken worker file must not hide the others. */ }
  }
  return parseObservedWorkers(rows, { maxTasksOf });
}

export async function readLocalSales(directory, now = Date.now()) {
  const rows = [];
  const statuses = { reserved: 'queued', running: 'running', delivery: 'running', paused: 'queued', blocked: 'blocked', done: 'completed' };
  const phases = { reserved: 'Reserviert', running: 'In Bearbeitung', delivery: 'PDF-Upload', blocked: 'Sales blockiert', done: 'Fertig' };
  let names;
  try { names = await fs.readdir(directory); }
  catch { throw new Error('Sales-Jobablage ist nicht lesbar; bisheriger Queue-Stand bleibt erhalten.'); }
  for (const name of names) {
    if (!/^\d+\.\d+$/.test(name)) continue;
    try {
      const file = path.join(directory, name, 'job.json');
      let stat;
      try { stat = await fs.lstat(file); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Backlog bookkeeping may contain only an existing-delivery receipt.
        // It is terminal evidence, not an accepted job with missing state.
        const receiptFile = path.join(directory, name, 'existing-delivery.json');
        const receiptStat = await fs.lstat(receiptFile);
        if (!receiptStat.isFile() || receiptStat.size > 16384) throw error;
        const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
        const recorded = Date.parse(receipt.recorded_at);
        const timestamp = value => /^\d{10}\.\d{6}$/.test(String(value || ''));
        const delivered = receipt.status === 'existing-delivery' && Array.isArray(receipt.files)
          && receipt.files.length === 3 && receipt.files.every(entry => /^F[A-Z0-9]+$/.test(entry.id || '') && entry.uploaded === true);
        const replaced = receipt.status === 'superseded' && timestamp(receipt.existing_delivery_ts)
          || receipt.status === 'duplicate' && timestamp(receipt.original_ts);
        if (!receipt.authorized_by || !Number.isFinite(recorded) || recorded > now + 30000 || !(delivered || replaced)) throw error;
        continue;
      }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Ungültige Jobdatei');
      const job = JSON.parse(await fs.readFile(file, 'utf8'));
      if (job.status === 'aborted') continue;
      const paused = job.status === 'paused' || (['reserved', 'running', 'delivery'].includes(job.status) && job.monitor?.paused === true);
      const status = Object.hasOwn(statuses, job.status) ? paused ? 'queued' : statuses[job.status] : undefined;
      const stamp = job.observed_at || job.updated_at || job.created_at;
      const finished = job.completed_at || job.finished_at || job.done_at || job.delivered_at;
      const finishedTime = typeof finished === 'number' ? finished : Date.parse(finished);
      const seen = typeof stamp === 'number' ? stamp : Date.parse(stamp);
      if (!status || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(job.worker)
        || !Number.isFinite(seen) || seen > now + 30000) throw new Error('Ungültiger Jobstatus');
      const url = new URL(job.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Ungültige Shopadresse');
      const blockedReason = status === 'blocked' ? displayText(job.reason, 500, 'Sales-Lauf ist blockiert') : undefined;
      // Job state is authoritative. A missing heartbeat must never remove accepted work.
      const awaitingWorker = ['queued', 'running'].includes(status) && now - seen > 30 * 60000;
      rows.push({ id: `sales:${name}`, title: `Sales · ${url.hostname}`, url: url.href, workflow: 'sales', status,
        sourceStatus: job.status, workerId: job.worker, attemptId: displayText(job.owner, 200),
        phase: paused ? 'Pausiert · wartet außerhalb der Worker-Plätze' : awaitingWorker ? 'Worker-Meldung ausstehend' : phases[job.status],
        ...(blockedReason ? { blockedReason } : {}), ...(status === 'completed' ? { progress: 100, ...(Number.isFinite(finishedTime) ? { completedAt: new Date(finishedTime).toISOString(), completionSource: 'sales' } : {}) } : {}),
        updatedAt: new Date(seen).toISOString() });
    } catch {
      throw new Error(`Sales-Job ${name} konnte nicht vollständig gelesen werden; bisheriger Queue-Stand bleibt erhalten.`);
    }
  }
  return rows;
}

export function createLocalHubFetch(hub, { localHub, transport, spawnImpl = spawn, nodeBinary = process.execPath } = {}) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(String(localHub))) throw new Error('Lokaler Hub-Pfad ist ungültig.');
  // The Newsletter transport creates exactly the same remoteScript and parses
  // its response. Only the process carrying that script changes from SSH to a
  // local Node process; service credentials stay inside the existing Hub code.
  const fetchOnHub = transport.createHubFetch({ ...hub, hub_dir: localHub }, {
    spawnImpl: (binary, _args, options) => {
      if (binary !== 'ssh') throw new Error('Hub: unerwarteter Transportprozess.');
      return spawnImpl(nodeBinary, ['-'], { ...options, cwd: localHub });
    },
  });
  return async (url, options = {}) => {
    if ((options.method || 'GET').toUpperCase() !== 'GET' || options.body !== undefined || options.workerHeartbeat !== undefined) {
      throw new Error('Monitoring erlaubt ausschließlich lesende Hub-Abfragen.');
    }
    const request = transport.checkRequest(String(url), 'GET');
    if (request.method !== 'GET' || !['clickup', 'slack'].includes(request.service)) throw new Error('Monitoring-Quelle ist nicht erlaubt.');
    return fetchOnHub(url, { ...options, method: 'GET' });
  };
}

// A confirmed unowned checkpoint is held by the Hub. The producer is provenance,
// never the current Mac assignment. Read descriptors only, without loading jobs.
export async function readStoredCheckpoints(localHub) {
  const file = path.join(localHub, 'state/newsletter-continuations/queue.sqlite');
  try { await fs.access(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT run_id,task_id,producer,owner,ready_at FROM checkpoints WHERE owner IS NULL').all();
    const columns = db.prepare('PRAGMA table_info(checkpoints)').all().map(c => c.name);
    if (columns.includes('packed') && columns.includes('digest')) {
      const payload = db.prepare('SELECT digest,packed FROM checkpoints WHERE run_id=? AND task_id=? AND owner IS NULL');
      for (const row of rows) if (row.ready_at === 8640000000000000) {
        const packed = payload.get(row.run_id,row.task_id);
        if (packed) row.blocker = checkpointBlocker({ ...row, ...packed });
      }
    }
    return rows;
  }
  finally { db.close(); }
}

export function applyStoredCheckpoints(rows, entries, bindings = new Map(rows.filter(row => row.run).map(row => [row.id, row.run]))) {
  for (const row of rows) {
    if (row.status === 'completed') continue;
    const run = bindings.get(row.id);
    if (!run) continue;
    const entry = entries.find(entry => !entry.owner
      && (entry.task_id === (run.jobId || run.taskId) || (row.workflow === 'correction' && row.id === `correction:${entry.task_id}`))
      && (entry.run_id === run.id || (['blocked','failed','queued'].includes(row.status)
        && entry.ready_at === 8640000000000000 && /^\d{8}T\d{6}Z-/.test(entry.run_id) && /^\d{8}T\d{6}Z-/.test(run.id)
        && entry.run_id.slice(0,16) > run.id.slice(0,16))));
    if (!entry) continue;
    row.workerId = undefined;
    row.attemptId = entry.run_id;
    if (entry.ready_at === 8640000000000000) {
      if (entry.blocker) Object.assign(row, entry.blocker);
      if (!/PM-Rückfrage|Wartet auf Fortsetzung/.test(row.phase || '')) row.status = 'blocked';
      if (!/PM-Rückfrage|Wartet auf Fortsetzung/.test(row.phase || '')) row.phase = 'Blockiert · Fortschritt im RS Hub gesichert';
    } else {
      row.status = 'queued';
      row.phase = 'Wartet · Fortsetzung im RS Hub gesichert';
    }
  }
  return rows;
}

// errorPayloads (optional Map): filled with ts -> metadata of every top-level copy
// in #ai-fehler, only after a complete read of that channel; the error-copy
// cleanup decides from it which copies stay before reading any thread.
export async function collectSnapshot({ config, hubFetch, workflows = DEFAULT_WORKFLOWS, fleetReader = readHubFleet, fleetDirectory, figmaBoardUrl, previews, previousTasks, salesReader, questionReader, checkpointReader, reservationReader, maxTasksOf, claimReader = listClaims, statusCache, epochRefusals = new Map(), warn = () => {}, admission = workerAdmission(), errorPayloads, now = Date.now() }) {
  validateWorkflows(workflows);
  const issues = new Map();
  const onMessage = message => {
    const issue = parseWorkerIssue(message);
    if (!issue) return;
    const key = `${issue.workerId}:${issue.stage}:${issue.severity}`;
    if (!issues.has(key) || Date.parse(issue.reportedAt) > Date.parse(issues.get(key).reportedAt)) issues.set(key, issue);
  };
  const errorChannel = config.monitor_channels?.errors || (config.fehler?.enabled ? config.fehler.channel_id : undefined);
  const errorMessages = [];
  const statuses = [...new Set([...workflows.flatMap(workflow => workflow.startStatuses ?? []), ...Object.keys(CORRECTION_STATUSES)].map(normalizeStatus))];
  const [taskResult, claimResult, workerResult, issueResult, salesResult, questionResult, checkpointResult, reservationResult] = await Promise.allSettled([
    (async () => {
      const variants = await discoverTags(hubFetch, config.clickup.workspace_id, workflows);
      // Tags keep completed and blocked history visible; the start statuses are
      // the orders, read and dated exactly as the worker does.
      const tagged = await listTasks(hubFetch, config.clickup.workspace_id, variants);
      const started = await listStatusTasks(hubFetch, config.clickup.workspace_id, statuses);
      // Like the worker, parked orders (manual, pop-up, test workspace) are never
      // dated; a cutover job is recognised only by its epoch.
      const dated = started.filter(task => !admission.parked(task, statusKindOf(task)));
      const epochs = await readStatusEpochs(hubFetch, dated, { refusals: epochRefusals, now,
        onRefused: (task, status) => warn(`ClickUp: Statusbeginn von Aufgabe ${task.id} abgewiesen (HTTP ${status}); nur diese Aufgabe wartet, erneute Abfrage in 15 Minuten.`) });
      const byId = new Map(tagged.map(task => [task.id, task]));
      let refused = 0;
      const parked = new Map();
      for (const task of started) {
        const refusal = !epochs.has(task.id) && epochRefusals.get(task.id);
        if (refusal) refused += 1;
        const reason = admission.parked(task, statusKindOf(task), epochs.get(task.id));
        if (reason) parked.set(reason, (parked.get(reason) || 0) + 1);
        byId.set(task.id, { ...task, ...(epochs.has(task.id) ? { statusSince: epochs.get(task.id) } : {}), ...(refusal ? { statusRefused: refusal.status } : {}) });
      }
      return { variants, started: started.length, refused, parked, tasks: [...byId.values()] };
    })(),
    (async () => {
      const claims = [];
      const channels = [...new Set([config.slack.channel_id, ...(config.monitor_channels?.claims || [])])];
      const lookbackDays = Number(config.claims?.lookback_days) || 60;
      // One decision per cycle: if any claim channel is missing, expired or stale
      // (429 fallback, failed read), all are read now, so a completely fresh cycle
      // (error-copy cleanup) recurs. After a fallback this cycle cannot be fresh;
      // the rest follow their own cache instead of spending the shared budget.
      let refresh = typeof claimReader.due === 'function' && claimReader.due(channels, { now, lookbackDays });
      // Sequential reads share Slack's token/rate limit with the actual workers.
      for (const channel of channels) {
        claims.push(...await claimReader(hubFetch, channel, { now, onMessage, lookbackDays, ...(refresh ? { refresh } : {}) }));
        if (refresh && claimReader.due([channel], { now, lookbackDays })) refresh = false;
      }
      return claims;
    })(),
    Promise.resolve().then(() => fleetReader(config.hub, { ...(fleetDirectory ? { fleetDirectory } : {}), ...(maxTasksOf ? { maxTasksOf } : {}) })),
    // Deletions and edits must reach the next snapshot too. An incremental
    // read only sees newer messages and can retain resolved worker errors.
    errorChannel ? claimReader(hubFetch, errorChannel, { now, lookbackDays: null, refresh: true,
      onMessage: message => { errorMessages.push(message); onMessage(message); } }) : Promise.resolve(),
    Promise.resolve().then(() => salesReader ? salesReader(now) : []),
    Promise.resolve().then(() => questionReader ? questionReader() : { sets: [], jobs: [] }),
    Promise.resolve().then(() => checkpointReader ? checkpointReader() : []),
    Promise.resolve().then(() => reservationReader ? reservationReader(now) : null),
  ]);
  // Clear resolved notices only after every configured warning channel was read completely.
  const workerIssues = claimResult.status === 'fulfilled' && issueResult.status === 'fulfilled' ? [...issues.values()] : undefined;
  if (errorPayloads) {
    errorPayloads.clear();
    if (errorChannel && issueResult.status === 'fulfilled') for (const message of errorMessages) {
      if ((message.thread_ts && message.thread_ts !== message.ts) || message.metadata?.event_type !== 'ai_newsletter_fehler') continue;
      const value = message.metadata.event_payload;
      if (typeof message.ts === 'string' && value && typeof value === 'object') errorPayloads.set(message.ts, value);
    }
  }
  if ([taskResult, claimResult, issueResult, salesResult, questionResult, checkpointResult].some(result => result.status === 'rejected')) {
    const error = [taskResult, claimResult, issueResult, salesResult, questionResult, checkpointResult].find(result => result.status === 'rejected').reason;
    return { ...(workerIssues === undefined ? {} : { workerIssues }), source: {
      name: SOURCE_NAME, error: displayText(error.message, 300, 'Quellenabfrage fehlgeschlagen.'),
    } };
  }
  const { variants, started, refused, parked, tasks } = taskResult.value;
  const parkedTotal = [...parked.values()].reduce((sum, count) => sum + count, 0);
  const parkedDetail = parkedTotal ? ` · ${parkedTotal} geparkt (${PARK_REASONS.filter(reason => parked.has(reason)).map(reason => `${parked.get(reason)} ${reason}`).join(', ')})` : '';
  // The RS Hub register owns reservations like for the workers. If it cannot be
  // read, Slack's copy keeps the queue visible and the source says so.
  const register = reservationResult.status === 'fulfilled' ? reservationResult.value : null;
  const claims = mergeHubClaims(claimResult.value, register);
  const registerDetail = reservationResult.status === 'rejected' ? 'RS-Hub-Reservierungsregister nicht lesbar; Reservierungen aus Slack'
    : register ? 'Reservierungen laut RS-Hub-Register' : undefined;
  const observedWorkers = workerResult.status === 'fulfilled' ? workerResult.value : undefined;
  const fleetDetail = workerResult.status === 'rejected'
    ? 'Hub-Worker-Dateien nicht verfügbar; Gerätewerte stammen weiter aus App-Berichten.' : undefined;
  const queue = buildQueue(tasks, claims, workflows, { now, staleMinutes: Number(config.claims?.stale_minutes) || 30, figmaBoardUrl, admission, workers: observedWorkers });
  // Keep a confirmed date after its source thread leaves the history window.
  // Any currently visible attempt prevents borrowing an older success.
  retainCompletionDates(queue, previousTasks, claims);
  const bindings = new Map(queue.filter(row => row.run).map(row => [row.id, row.run]));
  await addRunDetails(queue, { hubFetch, channelId: config.slack.channel_id, previews, previousTasks, now, statusCache });
  if (checkpointResult.status === 'fulfilled') applyStoredCheckpoints(queue, checkpointResult.value, bindings);
  // A stored terminal upload may first become blocked here. Its open question
  // still belongs to the exact source attempt after the producer Mac is cleared.
  applyPmQuestions(queue, questionResult.value, bindings);
  queue.push(...salesResult.value);
  applyBlockerContexts(queue, tasks, now);
  for (let index = 0; index < queue.length; index++) queue[index] = taskState.reconcileTask(queue[index]);
  if (queue.length > 5000) throw new Error('Queue enthält mehr als 5000 Einträge; bisheriger Snapshot bleibt erhalten.');
  const manualUploadIds = new Set(tasks.filter(task => admission.manualUpload(task)).map(task => task.id));
  const blockedErrors = errorChannel ? buildBlockedErrors(errorMessages, errorChannel, queue, { manualUploadIds }) : undefined;
  return { tasks: queue, ...(blockedErrors === undefined ? {} : { blockedErrors }), workerIssues, ...(observedWorkers === undefined ? {} : { observedWorkers }), source: {
    name: SOURCE_NAME, lastSuccessAt: new Date(now).toISOString(),
    detail: `${queue.length} Aufgaben · ${variants.length} Tags · ${started} im Startstatus${parkedDetail}${refused ? ` · ${refused} ohne lesbaren Statusbeginn` : ''} · ${claims.length} Reservierungen${registerDetail ? ` · ${registerDetail}` : ''}${blockedErrors ? ` · ${blockedErrors.length} offen in #ai-fehler` : ''}${fleetDetail ? ` · ${fleetDetail}` : ''}`,
  } };
}

export function relayEndpoint(relayUrl, teamId) {
  const url = new URL(relayUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))) throw new Error('Relay-URL muss HTTPS verwenden (lokal HTTP erlaubt).');
  if (!/^[A-Z0-9]{4,16}$/.test(teamId)) throw new Error('Team-ID ungültig.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/teams/${teamId}/queue`;
  return url;
}

export async function publishSnapshot(snapshot, { relayUrl, teamId, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('MONITOR_BRIDGE_TOKEN fehlt.');
  const response = await fetchImpl(relayEndpoint(relayUrl, teamId), { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Relay: HTTP ${response.status}; Snapshot wurde nicht bestätigt.`);
}

// Content-addressed and idempotent: the relay stores the JPEG under its SHA-256.
export async function uploadPreview(id, data, { relayUrl, teamId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Vorschau-ID ungültig.');
  if (typeof token !== 'string' || !token.trim()) throw new Error('MONITOR_BRIDGE_TOKEN fehlt.');
  const url = relayEndpoint(relayUrl, teamId);
  url.pathname = url.pathname.replace(/\/queue$/, `/fleet/previews/${id}`);
  const response = await fetchImpl(url, { method: 'PUT', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: data, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Relay: Vorschau HTTP ${response.status}.`);
}

export async function syncOnce({ collect, publish, cachedSource, save }) {
  let snapshot;
  try { snapshot = await collect(); }
  catch (error) {
    // Source-only error leaves every previously accepted task intact in the relay.
    const message = error instanceof Error ? error.message : 'Quellenabfrage fehlgeschlagen.';
    snapshot = { source: { name: SOURCE_NAME, ...(cachedSource?.lastSuccessAt ? { lastSuccessAt: cachedSource.lastSuccessAt } : {}), error: displayText(message, 300, 'Quellenabfrage fehlgeschlagen.') } };
    await publish(snapshot);
    return { ok: false, snapshot };
  }
  await publish(snapshot);
  if (save && !snapshot.source.error) await save(snapshot);
  return { ok: !snapshot.source.error, snapshot };
}

export function argumentsFrom(argv, env) {
  const values = { workerRoot: env.NEWSLETTER_WORKER_ROOT, relayUrl: env.MONITOR_RELAY_URL, teamId: env.MONITOR_TEAM_ID,
    token: env.MONITOR_BRIDGE_TOKEN, workflowsFile: env.MONITOR_WORKFLOWS_FILE, fleetDirectory: env.MONITOR_HUB_FLEET_DIRECTORY,
    interval: Number(env.MONITOR_BRIDGE_INTERVAL_SECONDS || 60), localHub: env.MONITOR_LOCAL_HUB, enrollmentConfig: env.MONITOR_ENROLLMENT_CONFIG,
    cacheFile: env.MONITOR_BRIDGE_CACHE || path.join(os.homedir(), '.cache', 'max-monitor', 'newsletter-bridge.json') };
  const keys = { '--worker-root': 'workerRoot', '--relay-url': 'relayUrl', '--team-id': 'teamId', '--workflows': 'workflowsFile', '--fleet-directory': 'fleetDirectory', '--interval': 'interval', '--cache': 'cacheFile', '--local-hub': 'localHub', '--enrollment-config': 'enrollmentConfig' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') values.once = true;
    else if (arg === '--cleanup-error-copies') values.cleanupErrorCopies = true;
    else if (arg === '--dry-run') { values.dryRun = true; values.once = true; }
    else if (arg === '--help') values.help = true;
    else if (keys[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) values[keys[arg]] = argv[++index];
    else throw new Error(`Unbekannter oder unvollständiger Parameter: ${arg}.`);
  }
  values.interval = Number(values.interval);
  if (!Number.isFinite(values.interval) || values.interval < 30 || values.interval > 86400) throw new Error('Intervall muss 30–86400 Sekunden sein.');
  if (values.enrollmentConfig) {
    if (!values.localHub) throw new Error('--enrollment-config ist nur für den zentralen --local-hub-Modus erlaubt.');
  }
  if (values.cleanupErrorCopies && (!values.localHub || !values.enrollmentConfig))
    throw new Error('Fehlerbereinigung ist nur im zentralen Hub-Dienst mit Enrollment-Konfiguration erlaubt.');
  return values;
}

export async function applyEnrollmentConfiguration(options) {
  if (!options.enrollmentConfig) return options;
  // Optional dynamic import keeps the existing standalone Mac bridge installer
  // independent of the central Hub provisioning helper.
  const { loadConfiguration } = await import('./enroll-monitor-worker.mjs');
  const settings = loadConfiguration({ env: {}, configPath: options.enrollmentConfig });
  if ((options.relayUrl && options.relayUrl !== settings.serverURL) || (options.teamId && options.teamId !== settings.teamId)) throw new Error('Relay-Adresse oder Team-ID widerspricht der privaten Hub-Konfiguration.');
  return { ...options, relayUrl: settings.serverURL, teamId: settings.teamId, token: settings.ownerToken };
}

export async function runSyncLoop(sync, { intervalMs, signal, once = false, now = Date.now, pause = delay }) {
  do {
    if (signal.aborted) break;
    const started = now();
    await sync();
    if (once || signal.aborted) break;
    // Poll start-to-start, without adding source-request time to the interval.
    const remaining = Math.max(0, intervalMs - (now() - started));
    try { await pause(remaining, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  } while (!signal.aborted);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = await applyEnrollmentConfiguration(argumentsFrom(argv, env));
  if (options.help) {
    console.log('node scripts/newsletter-monitor-bridge.mjs --worker-root <repo> [--once|--dry-run] [--workflows <json>] [--interval 60]\nHub-Dienst: --local-hub /opt/rs-hub --enrollment-config /etc/max-monitor/enrollment.json\nRelay: MONITOR_RELAY_URL, MONITOR_TEAM_ID, MONITOR_BRIDGE_TOKEN (admin/super; nur Umgebung).');
    return;
  }
  if (!options.workerRoot) throw new Error('NEWSLETTER_WORKER_ROOT oder --worker-root fehlt.');
  if (!options.dryRun) { relayEndpoint(options.relayUrl, options.teamId); if (!options.token) throw new Error('MONITOR_BRIDGE_TOKEN fehlt.'); }
  const root = path.resolve(options.workerRoot);
  // The worker's own Mac table (AGENTS.md) is the only source of a fallback maximum.
  const { loadConfig, maxTasksPerMac } = require(path.join(root, 'src', 'config.js'));
  const transport = require(path.join(root, 'src', 'hub-transport.js'));
  const config = loadConfig(path.join(root, 'config', 'worker.local.json'), { root });
  try { config.monitor_channels = JSON.parse(await fs.readFile(path.join(root, 'config', 'monitor-channels.json'), 'utf8')); }
  catch { /* Standalone bridges on older worker installations use their configured channel. */ }
  let figmaBoardUrl;
  try {
    const { PRE_GEN_FILE } = require(path.join(root, 'src', 'pre-gen.js'));
    if (typeof PRE_GEN_FILE === 'string' && /^[A-Za-z0-9]+$/.test(PRE_GEN_FILE)) figmaBoardUrl = `https://www.figma.com/design/${PRE_GEN_FILE}`;
  } catch { /* Older source installations still publish the task's own Figma link. */ }
  const workflows = validateWorkflows(options.workflowsFile ? JSON.parse(await fs.readFile(options.workflowsFile, 'utf8')) : DEFAULT_WORKFLOWS);
  // The queue shows only the orders the worker admits, by the worker's own rules.
  const { admission, missing: missingRules } = loadWorkerAdmission(root);
  if (missingRules.length) console.error(`${new Date().toISOString()} Worker-Regeln fehlen in --worker-root (${missingRules.join(', ')}); dafür parkt nur der Tag manuell.`);
  if (options.localHub) config.hub.hub_dir = options.localHub;
  const hubFetch = options.localHub ? createLocalHubFetch(config.hub, { localHub: options.localHub, transport }) : transport.createHubFetch(config.hub);
  const errorChannel = config.monitor_channels?.errors || (config.fehler?.enabled ? config.fehler.channel_id : undefined);
  const slackWrite = options.cleanupErrorCopies && !options.dryRun
    ? createErrorCleanupWriter(config.hub, { localHub: options.localHub, transport, errorChannel }) : undefined;
  let cached;
  try { cached = JSON.parse(await fs.readFile(options.cacheFile, 'utf8')); } catch { /* Fresh installation. */ }
  // Render previews need the Hub's own database and sharp; a Mac bridge has neither.
  let sharp;
  const hubRequire = options.localHub ? createRequire(path.join(options.localHub, 'package.json')) : undefined;
  const previews = options.localHub ? createRenderPreviews({ localHub: options.localHub,
    openDatabase: file => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true }),
    resize: buffer => resizeRender(sharp ??= hubRequire('sharp'), buffer),
    upload: options.dryRun ? async () => {} : (id, data) => uploadPreview(id, data, options) }) : undefined;
  const controller = new AbortController();
  const claimReader = createClaimReader();
  const statusCache = new Map();
  const epochRefusals = new Map();
  const errorPayloads = new Map();
  // The cleanup's last failure: logged once per episode, its end once (no line per minute).
  let cleanupProblem = null;
  const saveSnapshot = async snapshot => {
    await fs.mkdir(path.dirname(options.cacheFile), { recursive: true, mode: 0o700 });
    const temporary = `${options.cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    await fs.rename(temporary, options.cacheFile); cached = snapshot;
  };
  const readFleet = async () => {
    const url = relayEndpoint(options.relayUrl, options.teamId);
    url.pathname = url.pathname.replace(/\/queue$/, '/fleet');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${options.token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Monitor-Abgleich: HTTP ${response.status}.`);
    return response.json();
  };
  const audit = options.localHub && !options.dryRun ? createStatusAudit({ readFleet,
    save: report => saveStatusAudit(path.dirname(options.cacheFile), report) }) : undefined;
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await runSyncLoop(async () => {
      try {
        if (audit) {
          try { await audit.begin(() => {
            for (const channel of new Set([config.slack.channel_id, ...(config.monitor_channels?.claims || []), errorChannel].filter(Boolean))) claimReader.invalidate(channel);
            statusCache.clear();
          }); } catch { console.error(`${new Date().toISOString()} Status-Audit: Monitor nicht lesbar; regulärer Quellenabgleich läuft weiter.`); }
        }
        const readsBefore = { ...claimReader.stats };
        const result = await syncOnce({ collect: () => collectSnapshot({ config, hubFetch, workflows, claimReader, statusCache, epochRefusals, admission, errorPayloads, fleetDirectory: options.fleetDirectory, figmaBoardUrl,
          warn: message => console.error(`${new Date().toISOString()} ${displayText(message, 300)}`),
          previews, previousTasks: cached?.tasks, ...(typeof maxTasksPerMac === 'function' ? { maxTasksOf: maxTasksPerMac } : {}),
          ...(options.localHub ? { fleetReader: readLocalHubFleet,
            reservationReader: time => readHubReservations(hubRuntimeDirectory(options.localHub), { now: time, lookbackDays: Number(config.claims?.lookback_days) || 60 }),
            salesReader: time => readLocalSales(path.join(options.localHub, 'sales-newsletter'), time),
            questionReader: () => readPmQuestions(path.join(options.localHub, '..', 'rs-pm-question-pilot', 'state.sqlite')),
            checkpointReader: () => readStoredCheckpoints(options.localHub) } : {}) }), cachedSource: cached?.source,
          publish: snapshot => options.dryRun ? console.log(JSON.stringify(snapshot, null, 2)) : publishSnapshot(snapshot, options),
          save: options.dryRun ? undefined : saveSnapshot,
        });
        if (!options.dryRun) console.log(`${new Date().toISOString()} ${result.ok ? `Queue aktualisiert (${result.snapshot.tasks.length} Aufgaben).` : 'Quelle nicht erreichbar; letzte Queue bleibt erhalten.'}`);
        if (result.ok && audit) {
          try {
            const report = await audit.finish(result.snapshot, { fresh: freshClaimCycle(readsBefore, claimReader.stats) });
            if (report) {
              console.log(`${report.checkedAt} Status-Audit: ${report.tasksChecked} Aufgaben, ${report.repaired.length} Abweichungen behoben, ${report.findings.length} offen.`);
              if (!report.ok) await publishSnapshot({ source: { name: SOURCE_NAME,
                error: `Status-Abgleich: ${report.findings.length} widersprüchliche Anzeigen; erneute Prüfung läuft.` } }, options);
            }
          } catch { console.error(`${new Date().toISOString()} Status-Audit: Rücklesen fehlgeschlagen; Prüfung wird wiederholt.`); }
        }
        // Deleting needs claims read completely in this cycle; a cached or
        // rate-limit fallback read only feeds the display.
        if (result.ok && slackWrite && freshClaimCycle(readsBefore, claimReader.stats)) {
          try {
            const cleaned = await cleanupErrorCopies({ readFleet, hubFetch, slackWrite, errorChannel,
              payloadOf: ts => errorPayloads.get(ts) ?? null,
              archive: entry => fs.appendFile(path.join(path.dirname(options.cacheFile), 'error-copy-cleanup.jsonl'),
                JSON.stringify(entry) + '\n', { mode: 0o600 }) });
            if (cleanupProblem) { console.log(`${new Date().toISOString()} Fehlerbereinigung läuft wieder.`); cleanupProblem = null; }
            if (cleaned.deleted.length) {
              claimReader.invalidate(errorChannel);
              const ids = new Set(cleaned.deleted);
              const remaining = result.snapshot.blockedErrors.filter(error => !ids.has(error.id));
              const updated = { ...result.snapshot, blockedErrors: remaining,
                source: { ...result.snapshot.source, detail: result.snapshot.source.detail.replace(/\d+ offen in #ai-fehler/,
                  `${remaining.length} offen in #ai-fehler`) } };
              const latest = await readFleet();
              if (latest.queue.source.lastSuccessAt === result.snapshot.source.lastSuccessAt) {
                await publishSnapshot(updated, options); await saveSnapshot(updated);
              }
              // A cause post shown as several rows is one copy.
              const copies = new Set(cleaned.deleted.map(id => id.replace(/#.*$/, ''))).size;
              console.log(`${new Date().toISOString()} ${copies} aufgehobene Fehlerkopien entfernt.`);
            }
          } catch (error) {
            const message = String(error.message).replaceAll(options.token || '\0', '[REDACTED]').slice(0, 200);
            if (message !== cleanupProblem) console.error(`${new Date().toISOString()} Fehlerbereinigung: ${message} (weitere gleiche Fehler werden nicht erneut gemeldet; Bereinigung wird jeden Abgleich wiederholt)`);
            cleanupProblem = message;
          }
        }
        if (!result.ok && options.once) process.exitCode = 1;
      } catch (error) {
        // Never print an upstream response body or a token.
        console.error(`${new Date().toISOString()} ${String(error.message).replaceAll(options.token || '\0', '[REDACTED]').slice(0, 300)}`);
        if (options.once) process.exitCode = 1;
      }
    }, { intervalMs: options.interval * 1000, signal: controller.signal, once: options.once });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(String(error.message).replaceAll(process.env.MONITOR_BRIDGE_TOKEN || '\0', '[REDACTED]').slice(0, 300)); process.exitCode = 1; });
}
