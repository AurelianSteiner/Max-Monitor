// Shared fleet/queue state. Provider credentials never belong in this store.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HEARTBEAT_INTERVAL_SECONDS = 600;
const SILENT_AFTER_MS = 15 * 60 * 1000;
const OFFLINE_AFTER_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_MACHINES = 500;
const MAX_TASKS = 5000;
const MAX_QUEUE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set(["queued", "running", "blocked", "completed", "failed"]);

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
        usageUpdatedAt: timestamp(raw.usageUpdatedAt, "account.usageUpdatedAt", true),
        usageError: diagnostic(raw.usageError, "account.usageError"),
      });
    });
    if (limits.some((limit) => !accountIds.has(limit.accountId))) throw new FleetError(400, "limit.accountId fehlt in accounts");
  }
  return optionalFields({
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

function validateQueue(body) {
  object(body, "queue");
  const rawSource = object(body.source, "source");
  const source = optionalFields({
    name: string(rawSource.name, "source.name", 120),
    lastSuccessAt: timestamp(rawSource.lastSuccessAt, "source.lastSuccessAt", true),
    error: diagnostic(rawSource.error, "source.error"),
    detail: diagnostic(rawSource.detail, "source.detail"),
  });
  // A failed poll must never replace the last complete snapshot with an empty queue.
  if (source.error) return { source };
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
    const tags = raw.tags === undefined ? [] : raw.tags;
    if (!Array.isArray(tags) || tags.length > 30) throw new FleetError(400, "task.tags ist ungültig");
    return optionalFields({
      id,
      title: string(raw.title, "task.title", 300),
      workflow: string(raw.workflow, "task.workflow", 80),
      status,
      tags: [...new Set(tags.map((tag) => string(tag, "task.tag", 80)))],
      url,
      sourceStatus: string(raw.sourceStatus, "task.sourceStatus", 120, true),
      workerId: string(raw.workerId, "task.workerId", 120, true),
      phase: string(raw.phase, "task.phase", 160, true),
      progress: percent(raw.progress, "task.progress", true),
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
      });
    });
  }
  return optionalFields({ tasks, source, observedWorkers });
}

function machineStatus(machine, now) {
  if (!machine.lastSeenAt) return "offline";
  const age = now - Date.parse(machine.lastSeenAt);
  if (!Number.isFinite(age) || age < -5 * 60 * 1000) return "offline";
  return age > OFFLINE_AFTER_MS ? "offline" : age > SILENT_AFTER_MS ? "silent" : "online";
}

function publicMachine(machine, now) {
  const { ownerId, derivedStatus, ...visible } = machine;
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
    limits,
    ...(machine.accounts ? { accounts } : {}),
    telemetrySource: "app",
    memberId: ownerId === "__team_owner__" ? null : ownerId,
    status: machineStatus(machine, now),
    heartbeatAgeSeconds: machine.lastSeenAt ? Math.max(0, Math.floor((now - Date.parse(machine.lastSeenAt)) / 1000)) : null,
    usageStale,
    usageStatus,
    clockSkewSeconds: Math.round((Date.parse(machine.reportedAt) - Date.parse(machine.lastSeenAt)) / 1000),
  };
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

  function write(teamId, state) {
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
    for (const listener of subscribers.get(teamId) || []) {
      try { listener(); } catch { /* A disconnected viewer cannot fail a write. */ }
    }
  }

  function event(state, type, entityId, title, message, time, context = null) {
    state.events.push({
      id: crypto.randomUUID(), type, entityId, title, message, at: new Date(time).toISOString(),
      ...(type.startsWith("task_") ? { taskId: entityId } : type.startsWith("machine_") ? { deviceId: entityId } : type.startsWith("worker_") ? { workerId: entityId } : {}),
      ...(context ? { workerId: context.workerId || null } : {}),
      ...(context?.workflow ? { workflow: context.workflow } : {}),
    });
    state.events = state.events.slice(-MAX_EVENTS);
  }

  function refreshStatuses(state, time) {
    let changed = false;
    for (const machine of state.machines) {
      const status = machineStatus(machine, time);
      if (machine.derivedStatus !== status) {
        event(state, `machine_${status}`, machine.deviceId, machine.name, status === "online" ? "Mac meldet sich wieder" : status === "silent" ? "Seit über 15 Minuten kein Heartbeat" : "Seit über 30 Minuten kein Heartbeat", time, machine);
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

  function heartbeat(teamId, who, raw) {
    const incoming = validateHeartbeat(raw);
    const state = read(teamId);
    const ownerId = who.member ? who.member.id : "__team_owner__";
    const previous = state.machines.find((machine) => machine.deviceId === incoming.deviceId);
    if (previous && previous.ownerId !== ownerId) throw new FleetError(409, "deviceId gehört bereits zu einem anderen Team-Mitglied");
    if (incoming.workerId && state.machines.some((machine) => machine.workerId === incoming.workerId && machine.deviceId !== incoming.deviceId)) {
      throw new FleetError(409, "workerId ist bereits einem anderen Mac zugeordnet");
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
    };
    // Usage retrieval and device availability are independent. Preserve the last
    // known usage when this heartbeat reports a provider/API error.
    if (incoming.usageError && !incoming.accounts?.length && previous) {
      machine.limits = previous.limits;
      if (previous.accounts && !machine.accounts) machine.accounts = previous.accounts;
      if (previous.usageUpdatedAt) machine.usageUpdatedAt = previous.usageUpdatedAt;
      else delete machine.usageUpdatedAt;
    } else if (previous && incoming.accounts) {
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
    const time = now();
    refreshStatuses(state, time);
    const oldSource = state.queue.source;
    if (incoming.source.error) {
      if (oldSource.error !== incoming.source.error) event(state, "queue_source_error", "queue", incoming.source.name, incoming.source.error, time);
      state.queue.source = { ...oldSource, name: incoming.source.name, error: incoming.source.error, receivedAt: new Date(time).toISOString(), ...(incoming.source.detail ? { detail: incoming.source.detail } : {}) };
    } else {
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
      if (oldSource.error) event(state, "queue_source_recovered", "queue", incoming.source.name, "Queue-Quelle ist wieder erreichbar", time);
      state.queue = {
        tasks: incoming.tasks,
        source: {
          ...incoming.source,
          lastSuccessAt: incoming.source.lastSuccessAt || new Date(time).toISOString(),
          receivedAt: new Date(time).toISOString(),
          error: null,
        },
      };
      if (incoming.observedWorkers !== undefined) {
        const previousWorkers = new Map((state.observedWorkers || []).map((worker) => [worker.workerId, worker]));
        state.observedWorkers = incoming.observedWorkers.map((worker) => ({ ...worker, derivedStatus: previousWorkers.get(worker.workerId)?.derivedStatus }));
        refreshStatuses(state, time);
      }
    }
    write(teamId, state);
    return { taskCount: state.queue.tasks.length, source: state.queue.source };
  }

  function snapshot(teamId) {
    const state = read(teamId);
    const time = now();
    if (refreshStatuses(state, time)) write(teamId, state);
    const source = state.queue.source;
    const successTime = Date.parse(source.lastSuccessAt || "");
    const stale = !Number.isFinite(successTime) || time - successTime > SILENT_AFTER_MS || successTime > time + 5 * 60 * 1000;
    const workers = new Map((state.observedWorkers || []).map((worker) => [worker.workerId, worker]));
    const machines = state.machines.map((machine) => {
      const worker = workers.get(machine.workerId);
      if (worker) workers.delete(machine.workerId);
      return { ...publicMachine(machine, time), ...(worker ? {
        workerLastSeenAt: worker.lastSeenAt,
        workerStatus: machineStatus(worker, time),
        workerVersion: worker.workerVersion,
        workerRevision: worker.workerRevision,
        pendingClickup: worker.pendingClickup,
      } : {}) };
    });
    for (const worker of workers.values()) {
      const { derivedStatus, ...visible } = worker;
      machines.push({ ...visible, deviceId: `hub:${worker.workerId}`, telemetrySource: "worker", memberId: null, limits: [], status: machineStatus(worker, time), heartbeatAgeSeconds: Math.max(0, Math.floor((time - Date.parse(worker.lastSeenAt)) / 1000)), usageStale: true, usageStatus: "unavailable" });
    }
    return {
      schema: 1,
      generatedAt: new Date(time).toISOString(),
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      machines: machines.sort((a, b) => a.name.localeCompare(b.name)),
      queue: { tasks: state.queue.tasks, source: { ...source, stale, status: source.error ? "error" : !source.lastSuccessAt ? "unavailable" : stale ? "stale" : "fresh" } },
      events: [...state.events].reverse(),
    };
  }

  return { heartbeat, updateQueue, snapshot, subscribe };
}

module.exports = { createFleetStore, FleetError, MAX_QUEUE_BODY_BYTES, validateHeartbeat, validateQueue };
