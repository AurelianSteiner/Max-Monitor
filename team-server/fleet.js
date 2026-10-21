// Shared fleet/queue state. Provider credentials never belong in this store.
const fs = require("node:fs");
const taskState = require("../scripts/task-state.cjs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateReport, publicReport } = require("./worker-reports");
const { newerCapabilities } = require("./integration-contract");
const { newerSkillRelease } = require("./skill-versions");

const CLEARED_BLOCKER_CONTEXT = Object.fromEntries(['blockerReason','reasonCode','responsibleRole','nextStep',
  'pmOwner','pmOwnerId','pmCheckedAt','blockerSource','blockerSourceRunId','blockerSourceHash','blockerRecordedAt'].map(key => [key, undefined]));
const HEARTBEAT_INTERVAL_SECONDS = 60;
const SILENT_AFTER_MS = 15 * 60 * 1000;
const OFFLINE_AFTER_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_MACHINES = 500;
const MAX_TASKS = 5000;
const MAX_QUEUE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set(["queued", "running", "blocked", "clarification", "completed", "failed"]);
// Phase of a live Mac's lagging reservation (scripts/newsletter-monitor-bridge.mjs RESERVATION_LAG_PHASE).
const RESERVATION_LAG_PHASE = "Wartet · Mac aktiv, Reservierungsmeldung an den RS Hub verzögert";
// Newsletter renders are stored next to fleet.json under their own SHA-256.
// The snapshot carries only small references, never image data.
const PREVIEW_ID = /^[a-f0-9]{64}$/;
const MAX_PREVIEWS_PER_TASK = 24;
const MAX_PREVIEW_BYTES = 2.5 * 1024 * 1024;
const PREVIEW_ORPHAN_GRACE_MS = 60 * 60 * 1000;
// Worker limits: occupied_tasks and per-kind places are bounded to 50; a
// heartbeat counts as current for the same 180 s the workers use (ausgleich.js).
const MAX_PLACES = 50;
const LOAD_FRESH_MS = 180 * 1000;

class FleetError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FleetError(400, `${field} muss ein Objekt sein`);
  }
  return value;
}

function string(value, field, max, optional = false) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FleetError(400, `${field} fehlt oder ist ungültig`);
  }
  return value.trim();
}

function timestamp(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new FleetError(400, `${field} muss ein ISO-Zeitpunkt sein`);
  }
  return new Date(value).toISOString();
}

function percent(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new FleetError(400, `${field} muss eine ganze Zahl von 0 bis 100 sein`);
  }
  return value;
}

function boolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new FleetError(400, `${field} muss true oder false sein`);
  return value;
}

function diagnostic(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 500) throw new FleetError(400, `${field} ist ungültig`);
  // Provider diagnostics sometimes contain multiline descriptions. Keep them
  // readable without letting those control characters reject device liveness.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || undefined;
}

function optionalFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function validateHeartbeat(body) {
  object(body, "heartbeat");
  if (typeof body.deviceId !== "string" || !UUID_PATTERN.test(body.deviceId)) {
    throw new FleetError(400, "deviceId muss eine stabile UUID sein");
  }
  if (!Array.isArray(body.limits) || body.limits.length > 50) throw new FleetError(400, "limits muss eine Liste mit höchstens 50 Einträgen sein");
  const ids = new Set();
  const limits = body.limits.map((raw) => {
    object(raw, "limit");
    const limit = optionalFields({
      accountId: string(raw.accountId, "limit.accountId", 120),
      label: string(raw.label, "limit.label", 160),
      kind: string(raw.kind, "limit.kind", 80),
      percent: percent(raw.percent, "limit.percent"),
      resetsAt: timestamp(raw.resetsAt, "limit.resetsAt", true),
      accountName: string(raw.accountName, "limit.accountName", 160, true),
      usageUpdatedAt: timestamp(raw.usageUpdatedAt, "limit.usageUpdatedAt", true),
      usageError: diagnostic(raw.usageError, "limit.usageError"),
    });
    const id = `${limit.accountId}\0${limit.kind}`;
    if (ids.has(id)) throw new FleetError(400, "doppelte accountId/kind-Kombination");
    ids.add(id);
    return limit;
  });
  let accounts;
  if (body.accounts !== undefined) {
    if (!Array.isArray(body.accounts) || body.accounts.length > 50) throw new FleetError(400, "accounts ist ungültig");
    const accountIds = new Set();
    accounts = body.accounts.map((raw) => {
      object(raw, "account");
      const accountId = string(raw.accountId, "account.accountId", 120);
      if (accountIds.has(accountId)) throw new FleetError(400, "doppelte accountId");
      accountIds.add(accountId);
      return optionalFields({
        accountId,
        name: string(raw.name, "account.name", 160),
        provider: string(raw.provider, "account.provider", 80),
        email: string(raw.email, "account.email", 254, true),
        usageUpdatedAt: timestamp(raw.usageUpdatedAt, "account.usageUpdatedAt", true),
        usageError: diagnostic(raw.usageError, "account.usageError"),
      });
    });
    if (limits.some((limit) => !accountIds.has(limit.accountId))) throw new FleetError(400, "limit.accountId fehlt in accounts");
  }
  const monitoringAccountId = string(body.monitoringAccountId, "monitoringAccountId", 120, true);
  if (monitoringAccountId && (!accounts || accounts.length !== 1 ||
      accounts[0].accountId !== monitoringAccountId || accounts[0].provider !== "claude" ||
      limits.some((limit) => limit.accountId !== monitoringAccountId))) {
    throw new FleetError(400, "Monitoring muss genau einen zugeordneten Claude-Account melden");
  }
  return optionalFields({
    monitoringAccountId,
    deviceId: body.deviceId.toLowerCase(),
    name: string(body.name, "name", 120),
    workerId: string(body.workerId, "workerId", 120, true),
    reportedAt: timestamp(body.reportedAt, "reportedAt"),
    batteryPercent: percent(body.batteryPercent, "batteryPercent", true),
    powerSource: string(body.powerSource, "powerSource", 32, true),
    isCharging: boolean(body.isCharging, "isCharging"),
    isAwake: boolean(body.isAwake, "isAwake"),
    stayAwakeEnabled: boolean(body.stayAwakeEnabled, "stayAwakeEnabled"),
    appVersion: string(body.appVersion, "appVersion", 40, true),
    limits,
    accounts,
    usageUpdatedAt: timestamp(body.usageUpdatedAt, "usageUpdatedAt", true),
    usageError: diagnostic(body.usageError, "usageError"),
  });
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new FleetError(400, `${field} ist ungültig`);
  return value;
}

// Same bounds as the worker heartbeat (hub-transport.js validPlaetze, occupied_tasks).
function workerPlaces(value) {
  if (value === undefined || value === null) return undefined;
  object(value, "worker.places");
  const kinds = ["newsletter", "klaviyo", "translation"];
  if (Object.keys(value).some((kind) => ![...kinds, "korrektur"].includes(kind)) || kinds.some((kind) => !Object.hasOwn(value, kind)))
    throw new FleetError(400, "worker.places ist ungültig");
  return Object.fromEntries(Object.keys(value).sort().map((kind) => [kind, integer(value[kind], "worker.places", 0, MAX_PLACES)]));
}

// Used places against the Mac maximum. A fresh direct report (every 15 s) wins
// over the Hub heartbeat (every 30–60 s); both carry the worker's own count.
function machineLoad(machine, hub, time) {
  const activity = machine.activity;
  const maximum = (value) => Number.isInteger(value) ? value : undefined;
  if (activity?.fresh && Number.isInteger(activity.occupiedTasks)) {
    return optionalFields({ occupied: activity.occupiedTasks, max: maximum(activity.maxTasks) ?? maximum(hub?.maxTasks),
      source: "agent", observedAt: activity.sampledAt, fresh: true });
  }
  if (!hub || !Number.isInteger(hub.occupiedTasks)) return undefined;
  const age = time - Date.parse(hub.lastSeenAt);
  return optionalFields({ occupied: hub.occupiedTasks, max: maximum(hub.maxTasks), source: "hub", observedAt: hub.lastSeenAt,
    fresh: Number.isFinite(age) && age >= -5 * 60 * 1000 && age <= LOAD_FRESH_MS });
}

function previewList(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PREVIEWS_PER_TASK) throw new FleetError(400, "task.previews ist ungültig");
  return value.map((raw) => {
    object(raw, "preview");
    if (typeof raw.id !== "string" || !PREVIEW_ID.test(raw.id)) throw new FleetError(400, "preview.id ist ungültig");
    return optionalFields({
      id: raw.id,
      mailId: string(raw.mailId, "preview.mailId", 200, true),
      title: string(raw.title, "preview.title", 200),
      subject: string(raw.subject, "preview.subject", 300, true),
      renderedAt: timestamp(raw.renderedAt, "preview.renderedAt"),
      render: integer(raw.render, "preview.render", 1, 10000),
      width: integer(raw.width, "preview.width", 1, 10000),
      height: integer(raw.height, "preview.height", 1, 100000),
    });
  });
}

function validateQueue(body) {
  object(body, "queue");
  const rawSource = object(body.source, "source");
  const source = optionalFields({
    name: string(rawSource.name, "source.name", 120),
    lastSuccessAt: timestamp(rawSource.lastSuccessAt, "source.lastSuccessAt", true),
    error: diagnostic(rawSource.error, "source.error"),
    detail: diagnostic(rawSource.detail, "source.detail"),
  });
  let workerIssues;
  if (body.workerIssues !== undefined) {
    if (!Array.isArray(body.workerIssues) || body.workerIssues.length > 1000) throw new FleetError(400, "workerIssues ist ungültig");
    workerIssues = body.workerIssues.map((raw) => {
      object(raw, "workerIssue");
      if (!["error", "warning"].includes(raw.severity)) throw new FleetError(400, "workerIssue.severity ist ungültig");
      return {
        id: string(raw.id, "workerIssue.id", 120),
        workerId: string(raw.workerId, "workerIssue.workerId", 120),
        stage: string(raw.stage, "workerIssue.stage", 80),
        severity: raw.severity,
        message: diagnostic(raw.message, "workerIssue.message") || "Worker-Fehler ohne Diagnose",
        reportedAt: timestamp(raw.reportedAt, "workerIssue.reportedAt"),
      };
    });
  }
  // Independent worker diagnostics may update even when the task source fails.
  if (source.error) return optionalFields({ source, workerIssues });
  if (!Array.isArray(body.tasks) || body.tasks.length > MAX_TASKS) {
    throw new FleetError(400, `tasks muss eine vollständige Liste mit höchstens ${MAX_TASKS} Einträgen sein`);
  }
  const ids = new Set();
  const tasks = body.tasks.map((raw) => {
    object(raw, "task");
    const id = string(raw.id, "task.id", 160);
    if (ids.has(id)) throw new FleetError(400, "doppelte task.id");
    ids.add(id);
    const status = string(raw.status, "task.status", 20);
    if (!TASK_STATUSES.has(status)) throw new FleetError(400, "task.status ist ungültig");
    const url = string(raw.url, "task.url", 2000, true);
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new FleetError(400, "task.url ist ungültig"); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new FleetError(400, "task.url muss HTTP(S) ohne Zugangsdaten verwenden");
    }
    const figmaUrl = string(raw.figmaUrl, "task.figmaUrl", 2000, true);
    if (figmaUrl) {
      let parsed;
      try { parsed = new URL(figmaUrl); } catch { throw new FleetError(400, "task.figmaUrl ist ungültig"); }
      if (parsed.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(parsed.hostname)
        || parsed.username || parsed.password || !/^\/(design|file|proto|board)\/[^/]+/.test(parsed.pathname))
        throw new FleetError(400, "task.figmaUrl muss auf ein Figma-Board verweisen");
    }
    const tags = raw.tags === undefined ? [] : raw.tags;
    if (!Array.isArray(tags) || tags.length > 30) throw new FleetError(400, "task.tags ist ungültig");
    return optionalFields({
      id,
      title: string(raw.title, "task.title", 300),
      workflow: string(raw.workflow, "task.workflow", 80),
      contentKind: ["newsletter", "flow", "popup"].includes(raw.contentKind) ? raw.contentKind : undefined,
      packageId: string(raw.packageId, "task.packageId", 160, true),
      language: ["de", "en", "it", "fr", "se", "sp"].includes(raw.language) ? raw.language : undefined,
      completedAt: timestamp(raw.completedAt, "task.completedAt", true),
      completionSource: ["slack", "register", "clickup", "review", "sales"].includes(raw.completionSource) ? raw.completionSource : undefined,
      status,
      tags: [...new Set(tags.map((tag) => string(tag, "task.tag", 80)))],
      url,
      figmaUrl,
      company: string(raw.company, "task.company", 200, true),
      sourceStatus: string(raw.sourceStatus, "task.sourceStatus", 120, true),
      workerId: string(raw.workerId, "task.workerId", 120, true),
      phase: string(raw.phase, "task.phase", 160, true),
      blockedReason: string(raw.blockedReason, "task.blockedReason", 500, true),
      blockerReason: string(raw.blockerReason, "task.blockerReason", 500, true),
      reasonCode: string(raw.reasonCode, "task.reasonCode", 80, true),
      responsibleRole: string(raw.responsibleRole, "task.responsibleRole", 80, true),
      nextStep: string(raw.nextStep, "task.nextStep", 300, true),
      pmOwner: string(raw.pmOwner, "task.pmOwner", 100, true),
      pmOwnerId: string(raw.pmOwnerId, "task.pmOwnerId", 64, true),
      pmCheckedAt: timestamp(raw.pmCheckedAt, "task.pmCheckedAt", true),
      blockerRecordedAt: timestamp(raw.blockerRecordedAt, "task.blockerRecordedAt", true),
      blockerSource: string(raw.blockerSource, "task.blockerSource", 80, true),
      blockerSourceRunId: string(raw.blockerSourceRunId, "task.blockerSourceRunId", 200, true),
      blockerSourceHash: string(raw.blockerSourceHash, "task.blockerSourceHash", 64, true),
      errorUrl: string(raw.errorUrl, "task.errorUrl", 2000, true),
      attemptId: string(raw.attemptId, "task.attemptId", 200, true),
      // The worker's live step changes every few minutes; unlike phase it is
      // neither a log event nor part of the completion version.
      step: string(raw.step, "task.step", 160, true),
      progress: percent(raw.progress, "task.progress", true),
      previews: previewList(raw.previews),
      updatedAt: timestamp(raw.updatedAt, "task.updatedAt", true),
    });
  });
  let observedWorkers;
  if (body.observedWorkers !== undefined) {
    if (!Array.isArray(body.observedWorkers) || body.observedWorkers.length > MAX_MACHINES) throw new FleetError(400, "observedWorkers ist ungültig");
    const workerIds = new Set();
    observedWorkers = body.observedWorkers.map((raw) => {
      object(raw, "worker");
      const workerId = string(raw.workerId, "worker.workerId", 120);
      if (workerIds.has(workerId)) throw new FleetError(400, "doppelte workerId");
      workerIds.add(workerId);
      if (raw.pendingClickup !== undefined && (!Number.isInteger(raw.pendingClickup) || raw.pendingClickup < 0 || raw.pendingClickup > 100000)) throw new FleetError(400, "worker.pendingClickup ist ungültig");
      return optionalFields({
        workerId,
        name: string(raw.name, "worker.name", 120),
        lastSeenAt: timestamp(raw.lastSeenAt, "worker.lastSeenAt"),
        workerVersion: string(raw.workerVersion, "worker.workerVersion", 80, true),
        workerRevision: string(raw.workerRevision, "worker.workerRevision", 80, true),
        pendingClickup: raw.pendingClickup,
        acceptingTasks: boolean(raw.acceptingTasks, "worker.acceptingTasks"),
        // The worker heartbeat's own admission count and maximum (all place holders).
        occupiedTasks: raw.occupiedTasks === undefined ? undefined : integer(raw.occupiedTasks, "worker.occupiedTasks", 0, MAX_PLACES),
        maxTasks: raw.maxTasks === undefined ? undefined : integer(raw.maxTasks, "worker.maxTasks", 0, MAX_PLACES),
        places: workerPlaces(raw.places),
      });
    });
  }
  let blockedErrors;
  if (body.blockedErrors !== undefined) {
    // Use the same bounds and URL checks as normal tasks, then require the
    // immutable Slack message identity. An incomplete scan never sends this.
    blockedErrors = validateQueue({ source: body.source, tasks: body.blockedErrors }).tasks;
    for (const row of blockedErrors) {
      // A cause post naming several orders adds one row per further order: #<job>.
      const match = /^slack-error:([A-Za-z0-9_-]+):(\d+\.\d+)(?:#[A-Za-z0-9_@-]{1,120})?$/.exec(row.id);
      let link;
      try { link = new URL(row.errorUrl); } catch { /* Rejected below. */ }
      if (!match || row.status !== 'blocked' || link?.protocol !== 'https:' || !link.hostname.endsWith('.slack.com')
        || link.username || link.password || link.pathname !== `/archives/${match[1]}/p${match[2].replace('.', '')}`)
        throw new FleetError(400, 'blockedErrors muss offene Slack-Fehlermeldungen mit passendem Permalink enthalten');
    }
  }
  return optionalFields({ tasks, source, observedWorkers, workerIssues, blockedErrors });
}

function machineStatus(machine, now) {
  if (!machine.lastSeenAt) return "offline";
  const age = now - Date.parse(machine.lastSeenAt);
  if (!Number.isFinite(age) || age < -5 * 60 * 1000) return "offline";
  return age > OFFLINE_AFTER_MS ? "offline" : age > SILENT_AFTER_MS ? "silent" : "online";
}

// Either authenticated source proves that this Mac is running. A queue sync,
// diagnostic, or implausible future worker clock must never renew its liveness.
function machineLiveness(machine, worker, now) {
  const lastSeenAt = [machine.lastSeenAt, worker?.lastSeenAt]
    .filter((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 5 * 60 * 1000)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return {
    lastSeenAt,
    status: machineStatus({ lastSeenAt }, now),
    heartbeatAgeSeconds: lastSeenAt ? Math.max(0, Math.floor((now - Date.parse(lastSeenAt)) / 1000)) : null,
  };
}

function workerDisplayName(workerId, fallback) {
  return require("./worker-identities.json")[workerId]?.name || workerId || fallback;
}

function publicMachine(machine, now) {
  const { ownerId, derivedStatus, ...visible } = machine;
  const boundAccount = machine.accounts?.length === 1 && machine.monitoringAccountId && machine.accounts.find((account) =>
    account.accountId === machine.monitoringAccountId && account.provider === "claude");
  // Old clients reported Account Limits. Never infer a worker account from them.
  const sourceAccounts = boundAccount ? [boundAccount] : [];
  const sourceLimits = boundAccount ? machine.limits.filter((limit) => limit.accountId === boundAccount.accountId) : [];
  machine = { ...machine, accounts: sourceAccounts, limits: sourceLimits,
    usageError: boundAccount ? machine.usageError : undefined,
    usageUpdatedAt: boundAccount ? machine.usageUpdatedAt : undefined };
  const globalUsageError = machine.accounts?.length ? undefined : machine.usageError;
  function freshness(updatedAt, error, available = true) {
    const usageTime = Date.parse(updatedAt || "");
    const usageStale = !Number.isFinite(usageTime) || now - usageTime > SILENT_AFTER_MS || usageTime > now + 5 * 60 * 1000;
    return { usageStale, usageStatus: error ? "error" : !available ? "unavailable" : usageStale ? "stale" : "fresh" };
  }
  const accounts = (machine.accounts || []).map((account) => ({ ...account, ...freshness(account.usageUpdatedAt, account.usageError || globalUsageError, machine.limits.some((limit) => limit.accountId === account.accountId)) }));
  const accountMap = new Map(accounts.map((account) => [account.accountId, account]));
  const limits = machine.limits.map((limit) => {
    const account = accountMap.get(limit.accountId);
    return { ...limit, ...freshness(limit.usageUpdatedAt || account?.usageUpdatedAt || machine.usageUpdatedAt, limit.usageError || account?.usageError || globalUsageError) };
  });
  const statuses = [...accounts, ...limits];
  const fallback = freshness(machine.usageUpdatedAt, machine.usageError, false);
  const usageStale = statuses.length ? statuses.some((entry) => entry.usageStale) : fallback.usageStale;
  const usageStatus = machine.usageError || statuses.some((entry) => entry.usageStatus === "error") ? "error" : !limits.length ? "unavailable" : usageStale ? "stale" : "fresh";
  return {
    ...visible,
    // Slack calls this Mac by worker_id; keep the OS name as separate metadata.
    name: workerDisplayName(machine.workerId, machine.name),
    deviceName: machine.name,
    limits,
    accounts,
    monitoringAccountId: boundAccount?.accountId || null,
    monitoringAccountStatus: boundAccount ? "connected" : "notConfigured",
    usageUpdatedAt: machine.usageUpdatedAt,
    usageError: machine.usageError,
    telemetrySource: "app",
    memberId: ownerId === "__team_owner__" ? null : ownerId,
    status: machineStatus(machine, now),
    heartbeatAgeSeconds: machine.lastSeenAt ? Math.max(0, Math.floor((now - Date.parse(machine.lastSeenAt)) / 1000)) : null,
    usageStale,
    usageStatus,
    clockSkewSeconds: Math.round((Date.parse(machine.reportedAt) - Date.parse(machine.lastSeenAt)) / 1000),
  };
}

function publicMachineEvent(entry, machines) {
  if (!entry.type.startsWith("machine_") && !entry.type.startsWith("worker_")) return entry;
  // Prefer the captured assignment. A legacy event may only identify the device;
  // never infer a mapping from a hostname or overwrite an explicit unassignment.
  const workerId = "workerId" in entry ? entry.workerId
    : entry.type.startsWith("worker_") ? entry.entityId
    : machines.find((machine) => machine.deviceId === (entry.deviceId || entry.entityId))?.workerId;
  return workerId ? { ...entry, title: workerDisplayName(workerId) } : entry;
}

// A worker reads the app's random device UUID on its own Mac and sends it with
// every admission check. That exact binding names an app without Worker ID in
// the dashboard. It is display only: worker-control ignores workerIdSource "worker",
// and an app's own Worker ID always wins.
function linkedWorkers(state) {
  const explicit = new Set(state.machines.map((machine) => machine.workerId).filter(Boolean));
  return new Map((state.workerLinks || []).filter((link) => !explicit.has(link.workerId)).map((link) => [link.deviceId, link.workerId]));
}

function withLinkedWorker(machine, links) {
  const workerId = !machine.workerId && links.get(machine.deviceId);
  return workerId ? { ...machine, workerId, workerIdSource: "worker" } : machine;
}

// A completion belongs to one blocking state, not every future attempt of a task.
function taskVersion(task) {
  const state = [task.status, task.phase || null, task.workerId || null, task.sourceStatus || null];
  // Preserve existing completion signatures for tasks without new diagnostics.
  const typed = task.blockerSource === 'checkpoint' && /^[a-f0-9]{64}$/.test(task.blockerSourceHash || '');
  // PM names and display wording can change without a new operation outcome.
  // Bind human decisions to the verified original, never its current PM caption.
  if (typed) state.push(task.attemptId || null, [task.blockerSourceRunId, task.blockerSourceHash, task.blockerReason || null]);
  else if (task.attemptId || task.blockedReason) state.push(task.attemptId || null, task.blockedReason || null);
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function publicTask(task, completions = []) {
  const version = taskVersion(task);
  const completion = completions.find((entry) => entry.taskId === task.id && entry.taskVersion === version);
  return completion
    ? { ...task, taskVersion: version, status: "completed", phase: "Manuell erledigt", completion: "manual", completionSource: "manual", completedAt: completion.completedAt }
    : { ...task, taskVersion: version };
}

function currentTask(task) {
  task = taskState.reconcileTask(task);
  if (task.completion === "manual" || task.status === "completed") return task;
  if (task.status === "clarification") return { ...task, status: "queued", workerId: null, phase: "Wartet · PM-Rückfrage" };
  // A published continuation is queued; old local pause tags retain its checkpoint.
  if (task.status === "queued" && /^Wartet(?:\s|$)/i.test(task.phase || "")) return task.phase === "Wartet · PM-Rückfrage" ? { ...task, workerId: null } : task;
  const normalize = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const prefix = { newsletter: "pregen", upload: "klaviyoupload" }[task.workflow];
  const paused = /^Pausiert(?:\s*[·:]|$)/i.test(task.phase || "")
    || (prefix && (task.tags || []).some(tag => normalize(tag) === prefix + "pausiert"));
  return paused && ["queued", "running"].includes(task.status)
    ? { ...task, status: "paused", phase: task.phase || "Pausiert · automatische Fortsetzung" } : task;
}

function technicalBlocker(task) {
  const reason = task.blockedReason || "";
  return /Fehlklassifikation|falsch.{0,40}(?:klassifi|eingestuft)|Verneinung|keine Black[- ]Week[- ]Gestaltung|HTTP\s*[45]\d{2}|ECONN|ETIMEDOUT|SyntaxError|TypeError|technische[rn]? (?:Fehler|Blockade)|Worker meldet sich nicht mehr/i.test(reason);
}

// Human decisions remain open work, but do not count as technical failures.
// Apply operator decisions to exactly the reviewed source state and diagnosis.
function withClarification(task, decisions = []) {
  if (!["blocked", "failed"].includes(task.status)
    || technicalBlocker(task)) return task;
  const decision = decisions.find(entry => entry.taskId === task.id && entry.taskVersion === task.taskVersion
    && entry.sourceUpdatedAt === (task.updatedAt || null)
    && (!task.blockedReason || entry.diagnosticVersion === taskVersion(task)));
  const reason = task.blockedReason || "";
  // A typed outcome is authoritative. Legacy free-text matching must not invent
  // a PM question merely because its cause is now visible. Since the bridge types
  // every blocked row (Fehleraudit 19.10.2026), only its unassigned codes stay
  // open to the text heuristic; a typed PM role is a PM question.
  const typed = task.reasonCode && !["blocker_review_required", "blocker_context_missing"].includes(task.reasonCode);
  const human = task.phase === "PM-Rückfrage offen" || (typed && task.responsibleRole === "PM")
    || (!typed && (/(?:Gestaltung|Design|Black[- ]Week).{0,70}(?:nicht freigegeben|Freigabe fehlt|Entscheidung.{0,30}fehlt)/i.test(reason)
    || /Entscheidung.{0,70}(?:Gestaltung|Design).{0,20}fehlt/i.test(reason)
    || /(?:PM|Valentin).{0,50}als Editor einlad/i.test(reason)));
  return decision || human ? { ...task, status: "queued", workerId: null, phase: "Wartet · PM-Rückfrage",
    blockedReason: decision?.reason || task.blockedReason || "PM-Rückfrage offen" } : task;
}

function errorTaskId(error, tasks) {
  const job = String(error.attemptId || "").replace(/^\d{8}T\d{6}Z-/, "");
  if (error.workflow === "correction") {
    const id = "correction:" + job;
    if (tasks.has(id)) return id;
    // Independent per-mail corrections share a ClickUp link; never collapse
    // their identities based on that link when the attempt is ambiguous.
  }
  let taskId;
  try {
    const url = new URL(error.url);
    if (url.hostname === "app.clickup.com") taskId = /^\/t\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  } catch { /* A worker diagnostic may have no task link. */ }
  if (taskId && ["newsletter", "upload"].includes(error.workflow)) return "clickup:" + error.workflow + ":" + taskId;
  if (taskId && error.workflow === "translation") {
    const language = /-uebersetzung-(en|it|fr|se|sp)$/.exec(job)?.[1];
    if (language) return "clickup:translation-" + language + ":" + taskId;
  }
  const matches = [...tasks.values()].filter(task => task.workflow === error.workflow && task.url && task.url === error.url);
  return matches.length === 1 ? matches[0].id : null;
}

function currentQueue(state, liveReports) {
  const tasks = new Map(state.queue.tasks.map(task => [task.id, currentTask(publicTask(task, state.queue.completions))]));
  const activeOwners = new Map();
  for (const report of liveReports) {
    const sampled = Date.parse(report.sampledAt);
    const active = new Set(report.activity.runs.map(run => run.id));
    for (const [id, task] of tasks) {
      if (report.activity.state !== "unknown" && task.workerId === report.workerId && ["running", "queued"].includes(task.status) && !active.has(id)
        && (!task.updatedAt || sampled >= Date.parse(task.updatedAt))) {
        // A live Mac's lagging reservation (bridge buildQueue) waits only while
        // that Mac does not contradict it; its own fresh report without the run
        // means Mac and reservation disagree (review D11-M2, Fehleraudit 17.10.2026).
        const waiting = task.status === "queued" && /^Wartet(?:\s*[·:]|$)/.test(task.phase || "")
          && task.phase !== RESERVATION_LAG_PHASE;
        tasks.set(id, { ...task, status: "queued", workerId: null,
          phase: waiting ? task.phase : "Worker-Abgleich ausstehend" });
      }
    }
    for (const run of report.activity.runs) {
      const previous = tasks.get(run.id);
      const paused = /^Pausiert(?:\s*[·:]|$)/i.test(run.step || "");
      if (paused && previous?.status === "queued" && /^Wartet · Fortsetzung in der zentralen Queue$/.test(previous.phase || "")) continue;
      if (!taskState.reportMayReplace(previous, run, report.sampledAt)) continue;
      const conflict = activeOwners.has(run.id) && activeOwners.get(run.id) !== report.workerId;
      activeOwners.set(run.id, report.workerId);
      tasks.set(run.id, { ...previous, ...run, ...CLEARED_BLOCKER_CONTEXT, blockedReason: undefined, errorUrl: undefined,
        completion: undefined, completedAt: undefined, workerId: conflict ? null : report.workerId,
        status: paused ? "paused" : run.status,
        phase: conflict ? "Mehrere Worker melden denselben Auftrag" : paused ? "Pausiert · automatische Fortsetzung"
          : run.status === "queued" ? "Reserviert" : "In Bearbeitung",
        updatedAt: report.sampledAt,
        progress: run.progress ?? (["running", "queued", "paused"].includes(previous?.status) ? previous.progress : undefined) });
    }
  }
  // Slack is diagnostic history, not an additional task inventory. Enrich only
  // the current blocking state with the latest error belonging to that attempt.
  const errors = [...(state.queue.blockedErrors || [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const diagnosed = new Set();
  for (const error of errors) {
    const id = errorTaskId(error, tasks);
    const task = tasks.get(id);
    const awaitingPm = task?.status === "queued" && task.phase === "Wartet · PM-Rückfrage";
    if (!task || diagnosed.has(id) || (!awaitingPm && !["blocked", "failed", "clarification"].includes(task.status))) continue;
    const attempt = task.runId || task.attemptId;
    if (attempt && error.attemptId && attempt !== error.attemptId) continue;
    if ((task.status === "clarification" || awaitingPm) && Date.parse(error.updatedAt) < Date.parse(task.updatedAt)) continue;
    if (!attempt && task.updatedAt && Date.parse(error.updatedAt) < Date.parse(task.updatedAt)) continue;
    tasks.set(id, { ...task, status: "blocked", ...(awaitingPm && technicalBlocker(error) ? { phase: "Blockiert" } : {}), blockedReason: error.blockedReason || task.blockedReason, errorUrl: error.errorUrl });
    diagnosed.add(id);
  }
  return [...tasks.values()].map(task => taskState.reconcileTask(withClarification(task, state.queue.clarifications)));
}

function createFleetStore(dataDir, now = Date.now) {
  const subscribers = new Map();
  function subscribe(teamId, listener) {
    filePath(teamId);
    if (!subscribers.has(teamId)) subscribers.set(teamId, new Set());
    const listeners = subscribers.get(teamId);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) subscribers.delete(teamId);
    };
  }
  function filePath(teamId) {
    if (!/^[A-Z0-9]{4,16}$/.test(teamId)) throw new FleetError(400, "Team-ID ist ungültig");
    return path.join(dataDir, teamId, "fleet.json");
  }

  function read(teamId) {
    const file = filePath(teamId);
    try {
      if (fs.statSync(file).size > MAX_STATE_BYTES) throw new Error("fleet too large");
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.schema !== 1 || !Array.isArray(state.machines) || !Array.isArray(state.events) || !state.queue || !Array.isArray(state.queue.tasks)) throw new Error("invalid fleet schema");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return { schema: 1, machines: [], observedWorkers: [], queue: { tasks: [], source: { name: null, lastSuccessAt: null, receivedAt: null, error: null } }, events: [] };
      throw new FleetError(500, "Gespeicherte Fleet-Daten konnten nicht gelesen werden");
    }
  }

  function write(teamId, state, notify = true) {
    const file = filePath(teamId);
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw new FleetError(400, "Fleet-Datenspeicher hat seine Größenbegrenzung erreicht");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* leave original intact */ }
      throw new FleetError(500, "Fleet-Daten konnten nicht gespeichert werden");
    }
    // Notify only after the complete snapshot has been persisted successfully.
    for (const listener of notify ? subscribers.get(teamId) || [] : []) {
      try { listener(); } catch { /* A disconnected viewer cannot fail a write. */ }
    }
  }

  function previewPath(teamId, id) {
    if (typeof id !== "string" || !PREVIEW_ID.test(id)) throw new FleetError(400, "Vorschau-ID ist ungültig");
    return path.join(path.dirname(filePath(teamId)), "previews", `${id}.jpg`);
  }

  // Idempotent upload by the queue bridge. The ID is the image's own hash, so
  // a stored file can never be replaced by different content.
  function savePreview(teamId, id, buffer) {
    const file = previewPath(teamId, id);
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PREVIEW_BYTES) throw new FleetError(413, "Vorschau ist zu groß");
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new FleetError(415, "Vorschau muss ein JPEG sein");
    if (crypto.createHash("sha256").update(buffer).digest("hex") !== id) throw new FleetError(400, "Vorschau passt nicht zu ihrer ID");
    const time = new Date(now());
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tmp, buffer, { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
      // A repeated upload restarts the grace period before its snapshot arrives.
      fs.utimesSync(file, time, time);
    } catch {
      throw new FleetError(500, "Vorschau konnte nicht gespeichert werden");
    }
    return { id, bytes: buffer.length };
  }

  function previewFile(teamId, id) {
    const file = previewPath(teamId, id);
    return fs.existsSync(file) ? file : null;
  }

  // Uploads precede the snapshot that references them; only older orphans go.
  function prunePreviews(teamId, state) {
    const directory = path.join(path.dirname(filePath(teamId)), "previews");
    const used = new Set(state.queue.tasks.flatMap((task) => (task.previews || []).map((entry) => entry.id)));
    let names;
    try { names = fs.readdirSync(directory); } catch { return; }
    const time = now();
    for (const name of names) {
      const id = /^([a-f0-9]{64})\.jpg$/.exec(name)?.[1];
      if (id && used.has(id)) continue;
      const file = path.join(directory, name);
      try {
        if (time - fs.statSync(file).mtimeMs > PREVIEW_ORPHAN_GRACE_MS) fs.rmSync(file, { force: true });
      } catch { /* Pruning is best effort and never fails a queue update. */ }
    }
  }

  function event(state, type, entityId, title, message, time, context = null) {
    state.events.push({
      id: crypto.randomUUID(), type, entityId,
      title: type.startsWith("machine_") ? context?.workerId || title
        : type.startsWith("worker_") ? entityId : title,
      message, at: new Date(time).toISOString(),
      ...(type.startsWith("task_") ? { taskId: entityId } : type.startsWith("machine_") ? { deviceId: entityId } : type.startsWith("worker_") ? { workerId: entityId } : {}),
      ...(context ? { workerId: context.workerId || null } : {}),
      ...(context?.workflow ? { workflow: context.workflow } : {}),
    });
    state.events = state.events.slice(-MAX_EVENTS);
  }

  function refreshStatuses(state, time) {
    let changed = false;
    const workers = new Map((state.observedWorkers || []).map((worker) => [worker.workerId, worker]));
    const links = linkedWorkers(state);
    for (const machine of state.machines) {
      const effective = withLinkedWorker(machine, links);
      const { status } = machineLiveness(machine, workers.get(effective.workerId), time);
      if (machine.derivedStatus !== status) {
        event(state, `machine_${status}`, machine.deviceId, machine.name, status === "online" ? "Mac meldet sich wieder" : status === "silent" ? "Seit über 15 Minuten kein Heartbeat" : "Seit über 30 Minuten kein Heartbeat", time, effective);
        machine.derivedStatus = status;
        changed = true;
      }
    }
    for (const worker of state.observedWorkers || []) {
      const status = machineStatus(worker, time);
      if (worker.derivedStatus !== status) {
        event(state, `worker_${status}`, worker.workerId, worker.name, status === "online" ? "Worker meldet sich" : status === "silent" ? "Worker meldet sich seit über 15 Minuten nicht" : "Worker meldet sich seit über 30 Minuten nicht", time);
        worker.derivedStatus = status;
        changed = true;
      }
    }
    return changed;
  }

  function heartbeat(teamId, who, raw, transport = null) {
    const incoming = validateHeartbeat(raw);
    const state = read(teamId);
    if ((state.deletedDevices || []).includes(incoming.deviceId) || (state.deletedWorkers || []).includes(incoming.workerId)) {
      throw new FleetError(410, "Dieser Mac wurde endgültig gelöscht");
    }
    const ownerId = who.member ? who.member.id : "__team_owner__";
    const previous = state.machines.find((machine) => machine.deviceId === incoming.deviceId);
    // An owner who opts in may resume their existing Mac after switching from
    // its member token. Preserve the device and worker identity without a duplicate.
    const ownerResumesMac = who.role === "super" && previous &&
      (previous.ownerId === "__team_owner__" ||
        (incoming.workerId && incoming.workerId === previous.workerId));
    if (previous && previous.ownerId !== ownerId && !ownerResumesMac) throw new FleetError(409, "deviceId gehört bereits zu einem anderen Team-Mitglied");
    if (incoming.workerId && state.machines.some((machine) => machine.workerId === incoming.workerId && machine.deviceId !== incoming.deviceId)) {
      throw new FleetError(409, "workerId ist bereits einem anderen Mac zugeordnet");
    }
    if (incoming.workerId && (state.workerLinks || []).some(link => link.workerId === incoming.workerId
      && link.deviceId !== incoming.deviceId && state.machines.some(machine => machine.deviceId === link.deviceId))) {
      throw new FleetError(409, "workerId ist bereits mit einem anderen Mac verbunden");
    }
    if (!previous && state.machines.length >= MAX_MACHINES) throw new FleetError(400, "zu viele Macs im Team");
    const time = now();
    refreshStatuses(state, time);
    const machine = {
      ...incoming,
      ownerId,
      memberName: who.member ? who.member.name : null,
      registeredAt: previous ? previous.registeredAt : new Date(time).toISOString(),
      lastSeenAt: new Date(time).toISOString(),
      derivedStatus: "online",
      ...(transport ? { trackingTransport: { ...transport, receivedAt: new Date(time).toISOString() } } : {}),
    };
    // Usage retrieval and device availability are independent. Preserve the last
    // known usage when this heartbeat reports a provider/API error.
    const sameMonitoringAccount = incoming.monitoringAccountId &&
      incoming.monitoringAccountId === previous?.monitoringAccountId;
    if (sameMonitoringAccount && incoming.usageError && !incoming.accounts?.length && previous) {
      machine.limits = previous.limits;
      if (previous.accounts && !machine.accounts) machine.accounts = previous.accounts;
      if (previous.usageUpdatedAt) machine.usageUpdatedAt = previous.usageUpdatedAt;
      else delete machine.usageUpdatedAt;
    } else if (sameMonitoringAccount && previous && incoming.accounts) {
      for (const account of machine.accounts) {
        if (!account.usageError) continue;
        const oldAccount = previous.accounts?.find((entry) => entry.accountId === account.accountId);
        if (oldAccount?.usageUpdatedAt) account.usageUpdatedAt = oldAccount.usageUpdatedAt;
        const oldLimits = previous.limits.filter((limit) => limit.accountId === account.accountId);
        if (oldLimits.length) {
          machine.limits = machine.limits.filter((limit) => limit.accountId !== account.accountId);
          machine.limits.push(...oldLimits.map((limit) => ({ ...limit, usageError: account.usageError })));
        }
      }
    }
    if (previous) {
      if (previous.derivedStatus !== "online") event(state, "machine_online", machine.deviceId, machine.name, "Mac meldet sich wieder", time, machine);
      state.machines[state.machines.indexOf(previous)] = machine;
    } else {
      state.machines.push(machine);
      event(state, "machine_registered", machine.deviceId, machine.name, "Mac mit dem Team verbunden", time, machine);
    }
    write(teamId, state);
    return publicMachine(machine, time);
  }

  function updateQueue(teamId, raw) {
    const incoming = validateQueue(raw);
    const state = read(teamId);
    if (incoming.source.lastSuccessAt && state.queue.source.lastSuccessAt
      && Date.parse(incoming.source.lastSuccessAt) < Date.parse(state.queue.source.lastSuccessAt))
      throw new FleetError(409, 'Veralteter Queue-Abgleich; der neuere gespeicherte Stand bleibt erhalten.');
    if (!incoming.source.error && Array.isArray(state.queue.blockedErrors) && incoming.blockedErrors === undefined)
      throw new FleetError(409, 'Vollständiger Abgleich von #ai-fehler fehlt; bisheriger Fehlerbestand bleibt erhalten.');
    const deleted = new Set(state.deletedWorkers || []);
    if (incoming.observedWorkers) incoming.observedWorkers = incoming.observedWorkers.filter((worker) => !deleted.has(worker.workerId));
    if (incoming.workerIssues) incoming.workerIssues = incoming.workerIssues.filter((issue) => !deleted.has(issue.workerId));
    const time = now();
    refreshStatuses(state, time);
    if (incoming.workerIssues !== undefined) {
      const previous = new Map((state.workerIssues || []).map(issue => [`${issue.workerId}:${issue.stage}:${issue.severity}`, issue]));
      const current = new Map(incoming.workerIssues.map(issue => [`${issue.workerId}:${issue.stage}:${issue.severity}`, issue]));
      for (const [key, issue] of current) {
        if (previous.get(key)?.message !== issue.message || previous.get(key)?.severity !== issue.severity)
          event(state, issue.severity === "warning" ? "worker_warning" : "worker_error", issue.workerId, issue.workerId, `${issue.stage}: ${issue.message}`, time);
      }
      for (const [key, issue] of previous) {
        if (!current.has(key)) event(state, "worker_recovered", issue.workerId, issue.workerId, `Warnung bei ${issue.stage} nicht mehr vorhanden`, time);
      }
      state.workerIssues = incoming.workerIssues;
    }
    const oldSource = state.queue.source;
    if (incoming.source.error) {
      if (oldSource.error !== incoming.source.error) event(state, "queue_source_error", "queue", incoming.source.name, incoming.source.error, time);
      state.queue.source = { ...oldSource, name: incoming.source.name, error: incoming.source.error, receivedAt: new Date(time).toISOString(), ...(incoming.source.detail ? { detail: incoming.source.detail } : {}) };
    } else {
      incoming.tasks = incoming.tasks.map(taskState.reconcileTask);
      // Never publish a reference whose image did not arrive.
      for (const task of incoming.tasks) {
        if (!task.previews) continue;
        task.previews = task.previews.filter((entry) => fs.existsSync(previewPath(teamId, entry.id)));
        if (!task.previews.length) delete task.previews;
      }
      const oldTasks = new Map(state.queue.tasks.map((task) => [task.id, task]));
      const incomingIds = new Set(incoming.tasks.map((task) => task.id));
      for (const task of incoming.tasks) {
        const old = oldTasks.get(task.id);
        if (!old || old.status !== task.status || old.workerId !== task.workerId || old.phase !== task.phase) {
          event(state, `task_${task.status}`, task.id, task.title, task.phase || `${task.workflow}: ${task.status}`, time, task);
        }
      }
      for (const task of state.queue.tasks) {
        if (!incomingIds.has(task.id)) event(state, "task_removed", task.id, task.title, "Aufgabe ist nicht mehr im vollständigen Queue-Snapshot", time, task);
      }
      if (incoming.blockedErrors !== undefined) {
        const oldErrors = new Map((state.queue.blockedErrors || []).map(task => [task.id, task]));
        const newErrors = new Set(incoming.blockedErrors.map(task => task.id));
        for (const task of incoming.blockedErrors) if (!oldErrors.has(task.id))
          event(state, 'task_blocked', task.id, task.title, task.blockedReason || task.phase, time, task);
        for (const task of oldErrors.values()) if (!newErrors.has(task.id))
          event(state, 'task_removed', task.id, task.title, 'Fehlermeldung steht nicht mehr in #ai-fehler', time, task);
      }
      if (oldSource.error) event(state, "queue_source_recovered", "queue", incoming.source.name, "Queue-Quelle ist wieder erreichbar", time);
      state.queue = {
        tasks: incoming.tasks,
        ...(incoming.blockedErrors === undefined ? {} : { blockedErrors: incoming.blockedErrors }),
        clarifications: (state.queue.clarifications || []).filter(entry => {
          const task = incoming.tasks.find(task => task.id === entry.taskId);
          return task && ["blocked", "failed"].includes(task.status)
            && entry.taskVersion === taskVersion(task) && entry.sourceUpdatedAt === (task.updatedAt || null);
        }),
        completions: (state.queue.completions || []).filter((entry) => {
          const task = incoming.tasks.find((task) => task.id === entry.taskId);
          return task && entry.taskVersion === taskVersion(task);
        }),
        source: {
          ...incoming.source,
          lastSuccessAt: incoming.source.lastSuccessAt || new Date(time).toISOString(),
          receivedAt: new Date(time).toISOString(),
          error: null,
        },
      };
      if (incoming.observedWorkers !== undefined) {
        const previousWorkers = new Map((state.observedWorkers || []).map((worker) => [worker.workerId, worker]));
        state.observedWorkers = incoming.observedWorkers.map((worker) => {
          const previous = previousWorkers.get(worker.workerId);
          // A slow bridge read must not roll back a newer persisted heartbeat.
          return previous && Date.parse(previous.lastSeenAt) > Date.parse(worker.lastSeenAt)
            ? previous : { ...worker, derivedStatus: previous?.derivedStatus };
        });
        refreshStatuses(state, time);
      }
    }
    write(teamId, state);
    if (!incoming.source.error) prunePreviews(teamId, state);
    return { taskCount: state.queue.tasks.length, source: state.queue.source };
  }

  function clarifyTask(teamId, who, raw) {
    object(raw, "clarification");
    const taskId = string(raw.taskId, "taskId", 160);
    const version = string(raw.taskVersion, "taskVersion", 64);
    const reason = diagnostic(raw.reason, "reason");
    if (!reason) throw new FleetError(400, "Der offene Klärungsbedarf fehlt.");
    const state = read(teamId);
    const source = state.queue.tasks.find(task => task.id === taskId);
    if (!source) throw new FleetError(404, "Die Aufgabe ist nicht mehr in der Queue.");
    if (version !== taskVersion(source)) throw new FleetError(409, "Die Aufgabe hat sich geändert. Aktualisiere die Ansicht.");
    const task = currentQueue(state, []).find(task => task.id === taskId);
    if (!["blocked", "failed", "clarification"].includes(task.status) && !(task.status === "queued" && task.phase === "Wartet · PM-Rückfrage"))
      throw new FleetError(409, "Nur offene Blockaden können zugeordnet werden.");
    if (technicalBlocker(task)) throw new FleetError(409, "Ein technischer Fehler bleibt blockiert.");
    // Use the unclassified, enriched diagnosis for expiry; classification is a view.
    const unclassified = currentQueue({ ...state, queue: { ...state.queue, clarifications: [] } }, [])
      .find(task => task.id === taskId);
    const original = { ...unclassified, status: source.status, phase: currentTask(publicTask(source, state.queue.completions)).phase };
    const entry = { taskId, taskVersion: version, diagnosticVersion: taskVersion(original),
      sourceUpdatedAt: source.updatedAt || null, reason, clarifiedAt: new Date(now()).toISOString(),
      clarifiedBy: who.member?.id || "__team_owner__" };
    state.queue.clarifications = [...(state.queue.clarifications || []).filter(item => item.taskId !== taskId), entry];
    event(state, "task_clarification", taskId, task.title, reason, now(), { ...task, status: "clarification" });
    write(teamId, state);
    return currentQueue(state, []).find(task => task.id === taskId);
  }

  function completeTask(teamId, who, raw) {
    object(raw, "completion");
    const taskId = string(raw.taskId, "taskId", 160);
    const version = string(raw.taskVersion, "taskVersion", 64);
    const state = read(teamId);
    if ((state.queue.blockedErrors || []).some(entry => entry.id === taskId))
      throw new FleetError(409, 'Dieser Fehler steht noch in #ai-fehler. Erst beheben; der nächste Slack-Abgleich entfernt ihn automatisch.');
    const task = state.queue.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new FleetError(404, "Die Aufgabe ist nicht mehr in der Queue. Aktualisiere die Ansicht.");
    if (version !== taskVersion(task)) throw new FleetError(409, "Die Aufgabe hat sich geändert. Aktualisiere die Ansicht und prüfe den neuen Status.");
    if (!["blocked", "failed"].includes(task.status)) throw new FleetError(409, "Nur blockierte oder fehlgeschlagene Aufgaben können abgehakt werden.");
    const completions = state.queue.completions || [];
    if (completions.some((entry) => entry.taskId === taskId && entry.taskVersion === version)) {
      return publicTask(task, completions);
    }
    const time = now();
    state.queue.completions = [...completions.filter((entry) => entry.taskId !== taskId), {
      taskId, taskVersion: version, completedAt: new Date(time).toISOString(),
      completedBy: who.member?.id || "__team_owner__",
    }];
    event(state, "task_completed", task.id, task.title, "Blockierung manuell als erledigt abgehakt", time, task);
    write(teamId, state);
    return publicTask(task, state.queue.completions);
  }

  function snapshot(teamId) {
    const state = read(teamId);
    const time = now();
    if (refreshStatuses(state, time)) write(teamId, state);
    const source = state.queue.source;
    const successTime = Date.parse(source.lastSuccessAt || "");
    const stale = !Number.isFinite(successTime) || time - successTime > SILENT_AFTER_MS || successTime > time + 5 * 60 * 1000;
    const workers = new Map((state.observedWorkers || []).map((worker) => [worker.workerId, worker]));
    const hubWorkers = new Map(workers);
    const links = linkedWorkers(state);
    const machines = state.machines.map((stored) => {
      const machine = withLinkedWorker(stored, links);
      const worker = workers.get(machine.workerId);
      if (worker) workers.delete(machine.workerId);
      return { ...publicMachine(machine, time),
        nativeLastSeenAt: machine.lastSeenAt,
        nativeStatus: machineStatus(machine, time),
        nativeHeartbeatAgeSeconds: machineLiveness(machine, null, time).heartbeatAgeSeconds,
        ...machineLiveness(machine, worker, time),
        ...(worker ? {
        workerLastSeenAt: worker.lastSeenAt,
        workerStatus: machineStatus(worker, time),
        workerHeartbeatAgeSeconds: machineLiveness(worker, null, time).heartbeatAgeSeconds,
        workerVersion: worker.workerVersion,
        workerRevision: worker.workerRevision,
        workerVersionObservedAt: worker.lastSeenAt,
        workerVersionSource: 'hub-heartbeat',
        pendingClickup: worker.pendingClickup,
        acceptingTasks: worker.acceptingTasks,
        occupiedTasks: worker.occupiedTasks,
        maxTasks: worker.maxTasks,
        places: worker.places,
      } : {}) };
    });
    for (const worker of workers.values()) {
      const { derivedStatus, ...visible } = worker;
      machines.push({ ...visible, workerVersionObservedAt: worker.lastSeenAt, workerVersionSource: 'hub-heartbeat', name: workerDisplayName(worker.workerId), deviceId: `hub:${worker.workerId}`, telemetrySource: "worker", memberId: null, limits: [], status: machineStatus(worker, time), heartbeatAgeSeconds: Math.max(0, Math.floor((time - Date.parse(worker.lastSeenAt)) / 1000)), usageStale: true, usageStatus: "unavailable" });
    }
    for (const issue of state.workerIssues || []) {
      let machine = machines.find(machine => machine.workerId === issue.workerId);
      if (!machine) {
        machine = { workerId: issue.workerId, name: workerDisplayName(issue.workerId), deviceId: `hub:${issue.workerId}`, telemetrySource: "worker", limits: [], status: "offline", usageStale: true, usageStatus: "unavailable" };
        machines.push(machine);
      }
      (machine.workerIssues ||= []).push(issue);
    }
    for (const machine of machines) {
      const report = (state.workerReports || []).find(report => report.workerId === machine.workerId);
      const observation = publicReport(report, time);
      // Version evidence has its own source time; arrival order is irrelevant.
      if (Date.parse(machine.workerVersionObservedAt) > Date.parse(observation.workerVersionObservedAt)) {
        delete observation.workerVersion; delete observation.workerRevision;
        delete observation.workerVersionObservedAt; delete observation.workerVersionSource;
      }
      Object.assign(machine, observation);
      if (machine.activity?.fresh) {
        machine.lastSeenAt = report.receivedAt;
        machine.heartbeatAgeSeconds = Math.max(0, (time - Date.parse(report.receivedAt)) / 1000);
        machine.status = 'online';
        machine.workerStatus = report.service.running ? 'online' : 'offline';
        machine.workerLastSeenAt = report.sampledAt;
        machine.workerHeartbeatAgeSeconds = Math.max(0, (time - Date.parse(report.sampledAt)) / 1000);
      }
      const load = machineLoad(machine, hubWorkers.get(machine.workerId), time);
      if (load) machine.load = load;
    }
    const liveReports = (state.workerReports || []).filter(report => publicReport(report, time).activity?.fresh);
    const queueTasks = currentQueue(state, liveReports);
    return {
      schema: 1,
      generatedAt: new Date(time).toISOString(),
      // Cosmetic aliases only; enrollment, SSH, task ownership and stored IDs stay unchanged.
      workerIdentities: require("./worker-identities.json"),
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      ...(state.latestSkillRelease ? { skillRelease: { ...state.latestSkillRelease,
        fresh: (state.workerReports || []).some(report => report.skillRelease?.revision === state.latestSkillRelease.revision
          && publicReport(report, time).skillRelease?.fresh === true) } } : {}),
      machines: machines.sort((a, b) => a.name.localeCompare(b.name)),
      queue: { tasks: queueTasks, errors: (state.queue.blockedErrors || []).map(error => publicTask(error)), source: { ...source, stale, status: source.error ? "error" : !source.lastSuccessAt ? "unavailable" : stale ? "stale" : "fresh" } },
      events: [...state.events].reverse().map((entry) => publicMachineEvent(entry, state.machines)),
    };
  }

  function workerReport(teamId, body) {
    let report;
    try { report = validateReport(body, now()); } catch { throw new FleetError(400, 'Ungültiger Worker-Bericht'); }
    const state = read(teamId);
    const reports = state.workerReports || [];
    const previous = reports.find(item => item.workerId === report.workerId);
    // A delayed response from an earlier agent invocation cannot roll back state.
    if (previous && Date.parse(previous.sampledAt) > Date.parse(report.sampledAt)) return { accepted: false };
    report.rsHubMcp = [previous?.rsHubMcp, previous?.integrationContract?.rsHubMcp,
      report.rsHubMcp, report.integrationContract?.rsHubMcp].reduce(newerCapabilities, undefined);
    if (report.integrationContract && report.rsHubMcp) report.integrationContract.rsHubMcp = report.rsHubMcp;
    state.workerReports = [...reports.filter(item => item.workerId !== report.workerId), report].slice(-MAX_MACHINES);
    state.latestSkillRelease = newerSkillRelease(state.latestSkillRelease, report.skillRelease);
    write(teamId, state);
    notify(teamId);
    return { accepted: true };
  }
  function workerReportStatus(teamId, workerId) {
    return { workerId, ...publicReport((read(teamId).workerReports || []).find(item => item.workerId === workerId), now()) };
  }

  // Called after an owner-authenticated admission check with the worker's own report.
  function linkWorker(teamId, workerId, deviceId) {
    const state = read(teamId);
    if ((state.deletedWorkers || []).includes(workerId)) return false;
    const current = state.workerLinks || [];
    const links = current.filter((link) => link.workerId !== workerId && link.deviceId !== deviceId);
    const device = state.machines.find((machine) => machine.deviceId === deviceId);
    if (device && !device.workerId && !state.machines.some((machine) => machine.workerId === workerId)) {
      links.push(current.find((link) => link.workerId === workerId && link.deviceId === deviceId) ||
        { workerId, deviceId, linkedAt: new Date(now()).toISOString() });
    }
    // Unchanged links keep their stored objects: no write, no dashboard reload.
    if (links.length === current.length && links.every((link) => current.includes(link))) return false;
    state.workerLinks = links;
    write(teamId, state);
    return true;
  }

  function assertEnrollmentAllowed(teamId, enrollment) {
    const state = read(teamId);
    if ((state.deletedWorkers || []).includes(enrollment.workerId) || (state.deletedDevices || []).includes(enrollment.deviceId)) {
      throw new FleetError(410, "Dieser Mac wurde endgültig gelöscht und wird nicht automatisch neu registriert");
    }
  }

  function removeMember(teamId, member) {
    const state = read(teamId);
    const owned = state.machines.filter((machine) => machine.ownerId === member.id);
    const devices = new Set(owned.map((machine) => machine.deviceId));
    const workers = new Set(owned.map((machine) => machine.workerId).filter(Boolean));
    if (member.enrollment) {
      const reassigned = state.machines.some((machine) => machine.deviceId === member.enrollment.deviceId && machine.ownerId !== member.id);
      if (!reassigned) {
        devices.add(member.enrollment.deviceId);
        workers.add(member.enrollment.workerId);
      }
    }
    const reportWorkers = new Set([...workers, ...(state.workerLinks || [])
      .filter(link => devices.has(link.deviceId)).map(link => link.workerId)]);
    // Purge external orders before committing state, so cleanup can be retried.
    for (const workerId of reportWorkers) require("./account-provisioning").remove(path.dirname(filePath(teamId)), workerId);
    state.workerReports = (state.workerReports || []).filter(report =>
      !reportWorkers.has(report.workerId) && !devices.has(report.deviceId));
    // Keep only identity deny lists, never deleted telemetry or account data.
    state.deletedDevices = [...new Set([...(state.deletedDevices || []), ...devices])];
    state.deletedWorkers = [...new Set([...(state.deletedWorkers || []), ...workers])];
    state.machines = state.machines.filter((machine) => machine.ownerId !== member.id && !devices.has(machine.deviceId));
    state.observedWorkers = (state.observedWorkers || []).filter((worker) => !workers.has(worker.workerId));
    // A worker-reported link only named this Mac; it is not one of its own identities.
    state.workerLinks = (state.workerLinks || []).filter((link) => !devices.has(link.deviceId) && !workers.has(link.workerId));
    state.workerIssues = (state.workerIssues || []).filter((issue) => !workers.has(issue.workerId));
    state.events = state.events.filter((entry) => entry.type.startsWith("machine_")
      ? !devices.has(entry.deviceId || entry.entityId)
      : entry.type.startsWith("worker_") ? !workers.has(entry.workerId || entry.entityId) : true);
    // Notify after membership revocation so revoked streams close immediately.
    // Queue tasks are shared work and remain available after deleting a Mac.
    write(teamId, state, false);
  }

  function notify(teamId) {
    for (const listener of subscribers.get(teamId) || []) {
      try { listener(); } catch { /* Disconnected viewers cannot fail deletion. */ }
    }
  }

  return { heartbeat, updateQueue, workerReport, workerReportStatus, completeTask, clarifyTask, snapshot, subscribe, removeMember, assertEnrollmentAllowed, linkWorker, notify, savePreview, previewFile };
}

module.exports = { createFleetStore, FleetError, MAX_QUEUE_BODY_BYTES, MAX_PREVIEW_BYTES, validateHeartbeat, validateQueue };
