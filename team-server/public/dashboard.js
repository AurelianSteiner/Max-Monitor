"use strict";

// Credentials deliberately live only in this closure. The native host injects
// its bootstrap before this script runs; browsers use the connection dialog.
(() => {
  const $ = (id) => document.getElementById(id);
  // One shared palette, delivered by the relay. Never use names for identity bindings.
  const workerName = (workerId, fallback = "Mac") => snapshot?.workerIdentities?.[workerId]?.name
    || ({ "macbook-till-main": "Till Main", "macbook-von-till-main-2": "Till Main 2",
      "mac-worker-6-64d66918": "MacWorker 6", "macbook-air-von-gustav-ccdf84ef": "MacWorker 7",
      "macbook-1": "Mac 1", "macbook-2": "Mac 2", "newsletter-mac-141b2976": "Mac 4",
      "macworker-5-schwarz": "Mac 5 schwarz", "mac-f121ae17": "Macworker vale" })[workerId]
    || workerId || fallback;
  function workerSwatch(workerId) {
    const color = snapshot?.workerIdentities?.[workerId]?.color;
    if (!/^#[0-9A-Fa-f]{6}$/.test(color || "")) return null;
    const swatch = node("span", "worker-color");
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-hidden", "true");
    return swatch;
  }
  // The relay can be hosted at / or behind a shared Hub path such as /max-monitor.
  const relayPrefix = location.pathname.replace(/\/(?:fleet|monitor)\/?$/, "");
  const bootstrap = window.__MAX_MONITOR__;
  delete window.__MAX_MONITOR__;
  let credentials =
    bootstrap?.teamId && bootstrap?.token
      ? { teamId: bootstrap.teamId, token: bootstrap.token }
      : null;
  let snapshot = null;
  let snapshotReceivedAt = null;
  const completingTasks = new Set();
  let busy = false;
  let fetchController = null;
  let generation = 0;
  let streamController = null;
  let streamRetry = null;
  let streamConnected = false;
  let liveRefreshTimer = null;
  let refreshQueued = false;
  const snapshotFreshnessMs = 90000;
  let lastResumeAt = -Infinity;
  // Render previews need the bearer token: downloaded once, shown as blob URLs.
  const previewImages = new Map();
  let openTask = null;
  const params = new URLSearchParams(location.search);
  let pipelinePeriod = params.get("pipeline-period") === "all" ? "all" : "today";
  let queuePeriod = params.get("queue-period") === "today" ? "today" : "all";
  let renderedDay = null;
  let view = params.get("view") || "overview";
  let logFilter = params.get("log") === "attention" ? "attention" : "all";
  if (view === "attention") {
    view = "log";
    logFilter = "attention";
  }
  let statusFilter = params.get("status") || "queued";
  let workerFilter = params.get("worker") || "";
  let workflowFilter = params.get("workflow") || "";
  let query = params.get("q") || "";
  let queuePage = 0;
  let logQuery = params.get("logq") || "";
  let logType = ["task", "machine", "source"].includes(params.get("logtype"))
    ? params.get("logtype") : "all";
  let logOldestFirst = params.get("logsort") === "oldest";
  const requestedLogPage = Number(params.get("logpage"));
  let logPage = Number.isSafeInteger(requestedLogPage) && requestedLogPage > 0
    ? requestedLogPage - 1 : 0;
  const pageSize = 50;
  const statusNames = {
    online: "Online",
    silent: "Meldung fehlt",
    offline: "Offline",
    unknown: "Unbekannt",
    queued: "Wartet",
    marked: "Markiert",
    paused: "Pausiert",
    running: "Läuft",
    blocked: "Blockiert",
    clarification: "PM Rückfragen",
    completed: "Erledigt",
    failed: "Fehler",
  };
  const workflowNames = {
    correction: "Korrektur",
    sales: "Sales",
    "pre-gen": "Pre-Gen",
    pregen: "Pre-Gen",
    newsletter: "Pre-Gen",
    upload: "Klaviyo-Upload",
    translation: "Übersetzung",
    "technical-repair": "Technische Reparatur",
    "customer-onboarding": "Kunden-Onboarding",
    "worker-errors": "Worker-Fehler",
    "task-errors": "Lauf-Fehler",
    "system-notices": "Betriebshinweis",
  };
  // Pipeline stages mirror the ClickUp tags: the trigger tag alone means
  // "markiert"; a state tag or a worker reservation moves a task to "wartet".
  const stages = [
    ["marked", "Markiert", "marked"],
    ["queued", "Wartet", "queued"],
    ["paused", "Pausiert", "paused"],
    ["running", "Läuft", "running"],
    ["clarification", "PM Rückfragen", "clarification"],
    ["blocked", "Blockiert", "blocked"],
    ["completed", "Erledigt", "completed"],
  ];
  const stageShort = { marked: "Mark.", queued: "Wart.", paused: "Paus.", running: "Läuft",
    clarification: "PM", blocked: "Block.", completed: "Fertig" };
  const pipelineOrder = ["newsletter", "upload", "correction", "translation"];
  const timeFormat = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  });
  const clockFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
  const resetFormat = new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
  const resetPartsFormat = new Intl.DateTimeFormat("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
  const numberFormat = new Intl.NumberFormat("de-DE");
  // Round only for presentation; quota decisions and sorting keep the measured value.
  function displayPercent(value) {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.max(0, Math.round(value)) : null;
  }
  function percentText(value) {
    const percent = displayPercent(value);
    return percent === null ? "—" : `${numberFormat.format(percent)} %`;
  }
  const dayFormat = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeZone: "Europe/Berlin" });
  function setSync(text, state) {
    $("sync-status").textContent = text;
    $("sync-status").dataset.state = state;
  }
  function languagePackageId(task) {
    if (!["newsletter", "translation"].includes(task.workflow)) return null;
    return task.packageId || /^clickup:(?:newsletter|translation-[a-z]{2}):([A-Za-z0-9]+)$/.exec(task.id)?.[1] || null;
  }
  function packageLanguage(task) {
    return task.language || /^clickup:translation-([a-z]{2}):/.exec(task.id)?.[1]
      || /^\s*\[?(EN|IT|FR|SE|SP)\]?(?:\s*[|¦:]\s*|\s+[-–—·]\s+)/u.exec(task.title || "")?.[1].toLowerCase();
  }
  function runningPackage(task) {
    if (task.status !== "queued" || task.blockedReason || /^(Pausiert|Wartet.*PM)/i.test(task.phase || "")) return null;
    const language = packageLanguage(task);
    const id = languagePackageId(task);
    if (!id || !language || language === "de") return null;
    return tasks().find(other => other.id !== task.id && languagePackageId(other) === id
      && other.status === "running" && other.workerId) || null;
  }
  function packageHint(task) {
    return runningPackage(task) ? `Sprachpaket läuft · ${packageLanguage(task).toUpperCase()} folgt im Paket` : null;
  }
  function stageOf(task) {
    if (runningPackage(task)) return "running";
    if (task.status !== "queued") return task.status;
    // Older relays keep open PM questions queued until an answer is accepted.
    if (task.phase === "Wartet · PM-Rückfrage") return "clarification";
    const waiting = task.workerId || (task.tags || []).some((tag) =>
      String(tag).toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]/gu, "").endsWith("wartet"))
      || /^(Reserviert|Worker-Abgleich|Wartet)/.test(task.phase || "");
    return waiting ? "queued" : "marked";
  }

  // A production day follows Berlin time, independent of the browser's timezone.
  function productionDay(value) {
    const time = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(time) ? dayFormat.format(time) : null;
  }
  function tasksInPeriod(items, period, now = Date.now()) {
    if (period !== "today") return items;
    const today = productionDay(now);
    return items.filter((task) => {
      return task.status !== "completed" || productionDay(task.completedAt) === today;
    });
  }
  function node(tag, className, value) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) result.textContent = value;
    return result;
  }
  function timestamp(value) {
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  function relative(value) {
    const parsed = timestamp(value);
    if (parsed === null) return "Noch keine Meldung";
    const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60000));
    if (minutes < 1) return "gerade eben";
    if (minutes < 60) return `vor ${numberFormat.format(minutes)} min`;
    if (minutes < 1440)
      return `vor ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    return timeFormat.format(new Date(parsed));
  }
  function exact(value) {
    const parsed = timestamp(value);
    return parsed === null ? "Unbekannt" : timeFormat.format(new Date(parsed));
  }
  function badge(value) {
    return node(
      "span",
      `status ${statusNames[value] ? value : "unknown"}`,
      statusNames[value] || value || "Unbekannt",
    );
  }
  function workflow(value) {
    const key = typeof value === "object" ? workflowKey(value) : value;
    const [base, kind] = String(key || "").split(":");
    const label = workflowNames[base] || base || "Workflow";
    return kind ? `${label} · ${{ newsletter: "Newsletter", flow: "Flows", popup: "Pop-ups", unknown: "Art unbekannt" }[kind] || kind}` : ["newsletter", "upload", "translation"].includes(base) ? `${label} · Alle Auftragsarten` : label;
  }
  function workflowKey(task) {
    return ["newsletter", "upload", "translation"].includes(task.workflow)
      ? `${task.workflow}:${task.contentKind || "unknown"}` : task.workflow;
  }
  function taskKindBadge(task) {
    const kind = task.workflow || "";
    const label = node("span", "workflow-name task-kind", workflowNames[kind] || kind || "Aufgabenart unbekannt");
    label.dataset.workflow = kind;
    label.title = `Aufgabenart: ${label.textContent}`;
    return label;
  }
  function matchesWorkflow(task, filter) {
    return !filter || task.workflow === filter || workflowKey(task) === filter;
  }
  function completionLabel(task) {
    if (runningPackage(task)) return "Paket läuft";
    if (task.status !== "completed") return statusNames[stageOf(task)] || task.status;
    if (task.completion === "manual") return "Manuell erledigt";
    if (task.completedAt) return "Fertig";
    if (task.workflow === "sales") return "Erledigt laut Sales-Auftrag";
    return task.completionSource === "review" ? "An Review übergeben"
      : task.completionSource === "register" ? "Erledigt laut RS Hub" : "Erledigt laut ClickUp";
  }
  function safeLink(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }
  function tasks() {
    const items = Array.isArray(snapshot?.queue?.tasks) ? snapshot.queue.tasks : [];
    // Old translation trigger tags can remain after the language mail itself
    // reached review. Keep its completed Pre-Gen row; hide only the idle duplicate.
    return items.filter(task => {
      const id = /^clickup:translation-([a-z]{2}):([A-Za-z0-9]+)$/.exec(task.id);
      if (!id || task.status !== "queued" || task.workerId || task.blockedReason
        || /^(Pausiert|Wartet.*PM)/i.test(task.phase || "")) return true;
      return !items.some(other => other.id === `clickup:newsletter:${id[2]}` && other.status === "completed"
        && packageLanguage(other) === id[1]
        && /^(approval intern|approval extern|qa|design revision intern|design revision extern)$/i.test(other.sourceStatus || ""));
    });
  }
  function machines() {
    if (!Array.isArray(snapshot?.machines)) return [];
    const elapsed = snapshotReceivedAt
      ? Math.max(0, (Date.now() - snapshotReceivedAt) / 1000)
      : 0;
    return snapshot.machines.map((machine) => {
      const age = Number.isFinite(machine.heartbeatAgeSeconds)
        ? machine.heartbeatAgeSeconds + elapsed
        : (Date.now() - (timestamp(machine.lastSeenAt) || 0)) / 1000;
      const agedStatus = (initial, seconds) => seconds > 1800 ? "offline" : seconds > 900 ? "silent" : initial;
      const sourceAge = (seconds, date) => Number.isFinite(seconds)
        ? seconds + elapsed : (Date.now() - (timestamp(date) || 0)) / 1000;
      return {
        ...machine,
        activity: machine.activity ? { ...machine.activity,
          fresh: machine.activity.fresh && Date.now() - timestamp(machine.activity.sampledAt) <= 45000 } : undefined,
        status: agedStatus(machine.status, age),
        nativeStatus: machine.nativeLastSeenAt
          ? agedStatus(machine.nativeStatus, sourceAge(machine.nativeHeartbeatAgeSeconds, machine.nativeLastSeenAt))
          : machine.nativeStatus,
        workerStatus: machine.workerLastSeenAt
          ? agedStatus(machine.workerStatus, sourceAge(machine.workerHeartbeatAgeSeconds, machine.workerLastSeenAt))
          : machine.workerStatus,
      };
    });
  }
  function isOpen(task) {
    return !["completed"].includes(task.status);
  }
  function matchesStatus(task, status) {
    if (status === "all") return true;
    if (status === "open") return isOpen(task);
    if (status === "blocked") return ["blocked", "failed"].includes(task.status);
    return stageOf(task) === status;
  }
  function usageStale(machine) {
    return (
      machine.usageStale === true ||
      machine.status !== "online" ||
      !timestamp(machine.usageUpdatedAt) ||
      Date.now() - timestamp(machine.usageUpdatedAt) > 15 * 60000
    );
  }
  function workerIssues(machine) {
    return (machine.workerIssues || []).slice().sort((a, b) =>
      (a.severity === "warning") - (b.severity === "warning") ||
      (b.stage === "claude") - (a.stage === "claude") || timestamp(b.reportedAt) - timestamp(a.reportedAt));
  }
  function workerIssueReason(issue) {
    if (issue.stage === "claude" && /OAuth.*expir|expir.*OAuth/i.test(issue.message)) return "Claude-Anmeldung abgelaufen (OAuth)";
    if (issue.stage === "claude" && /not logged in|please run \/login/i.test(issue.message)) return "Claude ist nicht angemeldet";
    const label = { claude: "Claude", clickup_list: "ClickUp-Abfrage", finalize: "Abschluss", update: "Update" }[issue.stage] || issue.stage;
    return `${issue.severity === "warning" ? "Worker-Warnung" : "Worker-Fehler"} · ${label}: ${issue.message}`;
  }
  function machineAttentionReasons(machine) {
    const reasons = workerIssues(machine).map(workerIssueReason);
    const limits = machine.limits || [];
    const provider = machineProviderLabel(machine);
    if (machine.status !== "online") {
      const source = machine.telemetrySource === "worker" ? "Worker" : "Mac";
      reasons.push(
        !timestamp(machine.lastSeenAt)
          ? `Keine ${source}-Meldung vorhanden`
          : machine.status === "offline"
          ? `Seit über 30 Minuten keine ${source}-Meldung`
          : machine.status === "silent"
            ? `Seit über 15 Minuten keine ${source}-Meldung`
            : `${source}-Erreichbarkeit unbekannt`,
      );
    }
    if (machine.workerStatus && machine.workerStatus !== "online" && machine.telemetrySource !== "worker")
      reasons.push(machine.workerStatus === "offline"
        ? `${machineWorkerLabel(machine)} meldet sich seit über 30 Minuten nicht${machine.status === "online" ? " – Mac-App ist separat erreichbar" : ""}`
        : `${machineWorkerLabel(machine)} meldet sich seit über 15 Minuten nicht${machine.status === "online" ? " – Mac-App ist separat erreichbar" : ""}`);
    if (machine.workerId && !machine.workerStatus && machine.telemetrySource !== "worker")
      reasons.push("Worker-Betriebsstatus noch nicht gemeldet");
    const pool = machine.claudeAccounts?.accounts;
    if(pool?.length===2) {
      const ready=pool.filter(a=>a.status==='ready' && !a.stale && Date.now()-timestamp(a.updatedAt)<=10*60000);
      if(!ready.length) reasons.push(pool.every(a=>a.status==='limited') ? "Claude-Limit erreicht: beide Accounts" : "Claude-Accounts werden geprüft");
    } else {
    if (machine.usageError || machine.usageStatus === "error")
      reasons.push(`${provider}-Kontingente konnten nicht geprüft werden${machine.usageError ? `: ${machine.usageError}` : ""}`);
    if (!limits.length) reasons.push(machine.monitoringAccountId
      ? `${provider}-Kontingente noch nicht gemeldet` : isCodexRepair(machine) ? "Codex auf diesem Worker-Mac anmelden" : "Monitoring-Account auf diesem Worker-Mac verbinden");
    else if (
      machine.usageStale ||
      !timestamp(machine.usageUpdatedAt) ||
      Date.now() - timestamp(machine.usageUpdatedAt) > 15 * 60000
    )
      reasons.push(`${provider}-Kontingente veraltet`);
    for (const limit of limits.filter((item) => item.percent >= 100)) {
      const label = [
        claudeAccountIdentity((machine.accounts || []).find(a => a.accountId === limit.accountId) || {name:limit.accountName}).name,
        limit.label || limit.kind,
      ]
        .filter(Boolean)
        .join(" · ");
      const updatedAt = timestamp(limit.usageUpdatedAt || machine.usageUpdatedAt);
      const old =
        machine.status !== "online" ||
        limit.usageStale ||
        limit.usageError ||
        limit.usageStatus === "error" ||
        !updatedAt ||
        Date.now() - updatedAt > 15 * 60000;
      reasons.push(
        old
          ? `Letzter gemeldeter ${provider}-Wert: 100 %${label ? ` · ${label}` : ""}`
          : `${provider}-Limit erreicht${label ? `: ${label}` : ""}`,
      );
    }
    }
    if (
      (!machine.nativeStatus || machine.nativeStatus === "online") &&
      machine.batteryPercent != null &&
      machine.batteryPercent <= 15 &&
      machine.powerSource !== "ac"
    )
      reasons.push(`Akku niedrig: ${percentText(machine.batteryPercent)}`);
    return reasons;
  }
  function machineDisplayStatus(machine) {
    if (machine.status !== "online") return machine.status || "unknown";
    if (machine.activity?.fresh && machine.service?.running === false) return "failed";
    if ((machine.workerIssues || []).some(issue => issue.severity === "error")) return "failed";
    if (machine.workerStatus && machine.workerStatus !== "online") return machine.workerStatus;
    if (machine.workerId && !machine.workerStatus && machine.telemetrySource !== "worker") return "unknown";
    return machine.status;
  }
  function workerFailureReason(machine) {
    if (machine.activity?.fresh && machine.service?.running === false) return "Worker-Dienst läuft nicht · Wartungsdienst prüft";
    if ((machine.workerIssues || []).some(issue => issue.severity === "error")) return machineAttentionReasons(machine)[0];
    if (machine.workerStatus && machine.workerStatus !== "online") return `Worker ${statusNames[machine.workerStatus] || machine.workerStatus}`;
    if (machine.workerId && !machine.workerStatus && machine.telemetrySource !== "worker") return "Worker-Status unbekannt";
    return null;
  }
  function attentionEntries(devices, items) {
    const entries = items
      .filter((task) => ["blocked", "failed", "clarification"].includes(task.status))
      .map((task) => ({
        type: "task",
        entity: task,
        reasons: [
          task.blockedReason || task.phase || (task.status === "blocked"
            ? "Aufgabe blockiert"
            : "Aufgabe fehlgeschlagen"),
        ],
      }));
    for (const machine of devices) {
      const reasons = machineAttentionReasons(machine);
      if (reasons.length)
        entries.push({ type: "machine", entity: machine, reasons });
    }
    return entries;
  }
  function saveFilters() {
    const state = new URLSearchParams();
    if (pipelinePeriod !== "today") state.set("pipeline-period", pipelinePeriod);
    if (queuePeriod !== "all") state.set("queue-period", queuePeriod);
    if (view !== "overview") state.set("view", view);
    if (logFilter !== "all") state.set("log", logFilter);
    if (statusFilter !== "queued") state.set("status", statusFilter);
    if (workerFilter) state.set("worker", workerFilter);
    if (workflowFilter) state.set("workflow", workflowFilter);
    if (query) state.set("q", query);
    if (logQuery) state.set("logq", logQuery);
    if (logType !== "all") state.set("logtype", logType);
    if (logOldestFirst) state.set("logsort", "oldest");
    if (logPage) state.set("logpage", logPage + 1);
    history.replaceState(
      null,
      "",
      location.pathname + (state.size ? "?" + state : ""),
    );
  }
  function selectView(next, status, log) {
    view = ["overview", "queue", "machines", "log", "usage"].includes(next)
      ? next
      : "overview";
    if (status) statusFilter = status;
    if (log) {
      logFilter = log;
      logQuery = "";
      logType = "all";
      logPage = 0;
    }
    queuePage = 0;
    saveFilters();
    render();
    if(view==='usage') { window.scrollTo({top:0,left:0,behavior:'auto'}); refreshConsumption(); }
  }
  async function consumptionRequest(route, method='GET', body) {
    if(!credentials) throw Error('Verbinde zuerst den Team-Server.');
    const response=await fetch(`${relayPrefix}/v1/teams/${encodeURIComponent(credentials.teamId)}${route}`,{
      method,headers:{Authorization:`Bearer ${credentials.token}`,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok) throw Error(data.error||`HTTP ${response.status}`);
    return data;
  }
  function refreshConsumption(){window.MaxMonitorConsumption?.refresh(consumptionRequest);}
  function showNotice(message) {
    $("notice").textContent = message || "";
    $("notice").hidden = !message;
  }
  function skeleton(className, lines = 3, tag = "div") {
    const shell = node(tag, className);
    for (let index = 0; index < lines; index++) shell.append(node("div", "loading-line"));
    shell.setAttribute("aria-label", "Wird geladen");
    return shell;
  }
  function loading() {
    if (snapshot) return;
    $("machine-grid").replaceChildren(...Array.from({ length: 3 }, () => skeleton("machine")));
    $("pipeline").replaceChildren(skeleton("pipeline-loading", 3));
    $("fleet-body").replaceChildren(...Array.from({ length: 4 }, () => {
      const row = node("tr");
      const cell = node("td");
      cell.colSpan = 7;
      cell.append(node("div", "loading-line"));
      row.append(cell);
      return row;
    }));
  }
  function overviewMessage(message) {
    $("pipeline").replaceChildren(node("div", "empty-state", message));
    const row = node("tr");
    const cell = node("td", "empty-state", message);
    cell.colSpan = 7;
    row.append(cell);
    $("fleet-body").replaceChildren(row);
  }
  function syncStatus() {
    if (!snapshot || busy || !$('connection-error').hidden) return;
    if (Date.now() - snapshotReceivedAt > snapshotFreshnessMs) {
      setSync(`Stand veraltet · ${clockFormat.format(new Date(snapshotReceivedAt))}`, 'error');
      return;
    }
    setSync(`${streamConnected ? 'Live' : 'Abgleich'} · ${clockFormat.format(new Date(snapshotReceivedAt))}`, streamConnected ? 'live' : 'polling');
  }
  function resumeLive() {
    if (!credentials || document.hidden) return;
    syncStatus();
    const now = Date.now();
    // WebKit can emit focus, pageshow and the native activation together.
    if (now - lastResumeAt < 1000) return;
    lastResumeAt = now;
    stopLive();
    if (busy) {
      refreshQueued = true;
      if (snapshotReceivedAt && now - snapshotReceivedAt > snapshotFreshnessMs) fetchController?.abort();
    } else refresh();
    startLive();
  }
  function watchLiveEvents() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopLive();
      else resumeLive();
    });
    window.addEventListener('pagehide', stopLive);
    for (const event of ['pageshow', 'focus', 'max-monitor-resume']) window.addEventListener(event, resumeLive);
  }
  function stopLive() {
    clearTimeout(streamRetry);
    clearTimeout(liveRefreshTimer);
    streamRetry = null;
    liveRefreshTimer = null;
    refreshQueued = false;
    const previous = streamController;
    streamController = null;
    streamConnected = false;
    previous?.abort();
  }
  function liveRefresh() {
    if (liveRefreshTimer) return;
    liveRefreshTimer = setTimeout(() => {
      liveRefreshTimer = null;
      if (!credentials || document.hidden) return;
      if (busy) refreshQueued = true;
      else refresh();
    }, 100);
  }
  function startLive() {
    if (!credentials || document.hidden || streamController) return;
    clearTimeout(streamRetry);
    streamRetry = null;
    connectLive();
  }
  async function connectLive() {
    const epoch = generation;
    const controller = new AbortController();
    streamController = controller;
    let timer = setTimeout(() => controller.abort(), 15000);
    let reader;
    let retry = true;
    try {
      const response = await fetch(`${relayPrefix}/v1/teams/${encodeURIComponent(credentials.teamId)}/fleet/events`, {
        headers: { Authorization: `Bearer ${credentials.token}`, Accept: 'text/event-stream' },
        cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) retry = false;
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body?.getReader) return;
      if (epoch !== generation || controller !== streamController) return;
      streamConnected = true;
      syncStatus();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 45000);
        const { value, done } = await reader.read();
        if (done || epoch !== generation || controller !== streamController) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 8192) throw new Error('Live signal too large');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^event:\s*fleet$/m.test(event)) liveRefresh();
        }
      }
    } catch { /* Regular GETs keep the last snapshot available during reconnects. */ }
    finally {
      clearTimeout(timer);
      if (reader) { try { await reader.cancel(); } catch { /* Already disconnected. */ } }
      if (controller !== streamController) return;
      streamController = null;
      streamConnected = false;
      syncStatus();
      if (retry && epoch === generation && credentials && !document.hidden) streamRetry = setTimeout(startLive, 5000);
    }
  }
  async function refresh() {
    if (!credentials || busy) return false;
    const epoch = generation;
    busy = true;
    $("refresh").disabled = true;
    $("connect").disabled = true;
    setSync("Aktualisiert…", "busy");
    loading();
    fetchController = new AbortController();
    const timeout = setTimeout(() => fetchController?.abort(), 15000);
    try {
      const response = await fetch(
        `${relayPrefix}/v1/teams/${encodeURIComponent(credentials.teamId)}/fleet`,
        {
          headers: { Authorization: `Bearer ${credentials.token}` },
          cache: "no-store",
          signal: fetchController.signal,
        },
      );
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new Error(
            "Team-ID oder Token wurde abgelehnt. Prüfe deine Verbindung.",
          );
        throw new Error(
          `Der Team-Server antwortet mit HTTP ${response.status}. Versuche es erneut.`,
        );
      }
      const data = await response.json();
      if (!Array.isArray(data.machines) || !Array.isArray(data.queue?.tasks))
        throw new Error(
          "Die Server-Version unterstützt die Worker-Übersicht noch nicht. Aktualisiere den Team-Server.",
        );
      if (epoch !== generation) return false;
      snapshot = data;
      snapshotReceivedAt = Date.now();
      setSync(`${streamConnected ? "Live" : "Abgleich"} · ${clockFormat.format(new Date())}`, streamConnected ? "live" : "polling");
      $("connection-error").hidden = true;
      showNotice(
        data.queue.source?.error
          ? `Queue-Quelle gestört: ${data.queue.source.error} Die letzte vollständige Queue bleibt sichtbar.`
          : !data.queue.source?.lastSuccessAt
            ? "Die Queue-Quelle ist noch nicht verbunden. Richte die Newsletter-Brücke auf einem zentralen Host ein."
            : Date.now() - timestamp(data.queue.source.lastSuccessAt) >
                5 * 60000
              ? `Die Queue wurde ${relative(data.queue.source.lastSuccessAt)} synchronisiert. Prüfe die Newsletter-Brücke.`
              : "",
      );
      render({ preserveScroll: true });
      if(view==='usage') refreshConsumption();
      startLive();
      return true;
    } catch (error) {
      if (epoch !== generation) return false;
      const message =
        error.name === "AbortError"
          ? "Der Team-Server antwortet nicht. Prüfe die Verbindung und aktualisiere erneut."
          : error.message;
      setSync("Verbindung gestört", "error");
      showNotice(
        snapshot
          ? `${message} Angezeigt wird der letzte geladene Stand.`
          : message,
      );
      if (snapshot) render({ preserveScroll: true });
      $("connection-error").textContent = message;
      $("connection-error").hidden = false;
      if (!snapshot) {
        const failed = "Daten konnten nicht geladen werden. Prüfe die Team-Verbindung (Zahnrad oben rechts).";
        $("machine-grid").replaceChildren(node("div", "empty-state", failed));
        overviewMessage(failed);
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (epoch === generation) {
        busy = false;
        fetchController = null;
        $("refresh").disabled = false;
        $("connect").disabled = false;
        if (refreshQueued) {
          refreshQueued = false;
          queueMicrotask(refresh);
        }
      }
    }
  }
  const skillNames = {
    "content-creation": "Content Creation", "newsletter-korrektur": "Correction", "rs-klaviyo-upload": "Klaviyo-Upload",
  };
  function latestSkills() {
    return Array.isArray(snapshot?.skillRelease?.items)
      ? snapshot.skillRelease.items.filter(item => Object.keys(skillNames).includes(item.id)) : [];
  }
  function skillsFresh(release, reportedAt = null) {
    const checked = timestamp(release?.checkedAt);
    const report = reportedAt ? timestamp(reportedAt) : Date.now();
    return release?.fresh === true && checked !== null && Date.now() - checked <= 180000
      && report !== null && Date.now() - report <= 45000;
  }
  function compareSkills(machine) {
    const installed = machine.skillRelease;
    if (!installed) return { state: "unknown", label: "Nicht gemeldet", differences: [] };
    const known = new Map(installed.items.map(item => [item.id, item]));
    const differences = latestSkills().filter(item => known.get(item.id)?.tree !== item.tree || known.get(item.id)?.version !== item.version)
      .map(item => `${skillNames[item.id] || item.id}: ${known.get(item.id)?.version || "fehlt"} → ${item.version}`);
    // The live observer rereads the installed immutable package. Its local Git
    // sync may be older while another Mac confirms the central reference now.
    const observedAt = timestamp(machine.agentLastSeenAt);
    const observedFresh = machine.agentStatus === "online" && observedAt !== null && Date.now() - observedAt <= 45000;
    if (!skillsFresh(snapshot?.skillRelease) || !observedFresh)
      return { state: "unknown", label: "Stand ungeprüft", differences };
    return { state: differences.length ? "pending" : "current", label: differences.length ? "Update ausstehend" : "Aktuell", differences };
  }
  function skillDetails() {
    const focusedWorker = document.activeElement?.dataset.skillWorker;
    const scrollTop = $("detail-body").scrollTop;
    const release = snapshot?.skillRelease;
    const description = node("p", "form-hint", "Neuester bestätigter RS-Skills-Stand für neue Aufträge. Laufende Aufträge behalten ihr fest zugeordnetes Skill-Paket.");
    const source = node("p", "form-hint", release ? `Skill-Abgleich: ${exact(release.checkedAt)} · ${skillsFresh(release) ? "aktuell" : "Stand ungeprüft"}` : "Noch keine Versionsmeldung.");
    const versions = node("ul", "skill-version-list");
    for (const item of latestSkills()) {
      const row = node("li", "", skillNames[item.id] || item.id);
      row.title = item.id; row.append(node("strong", "", item.version)); versions.append(row);
    }
    const list = node("ul", "skill-comparison-list");
    for (const machine of machines()) {
      const result = compareSkills(machine);
      const row = node("li");
      const head = node("div", "skill-comparison-head");
      const link = node("button", "text-button", workerName(machine.workerId, machine.name));
      link.dataset.skillWorker = machine.workerId || machine.id;
      link.type = "button"; link.addEventListener("click", () => machineDetails(machine));
      const state = node("span", "skill-comparison-state", result.label); state.dataset.state = result.state;
      head.append(link, state); row.append(head);
      if (result.differences.length) row.append(node("p", "form-hint", result.differences.join(" · ")));
      row.append(node("p", "form-hint", machine.skillRelease ? `Zuletzt abgeglichen: ${exact(machine.skillRelease.checkedAt)}` : "Dieser Mac hat noch keinen installierten Skill-Stand gemeldet."));
      list.append(row);
    }
    openDetail("Skill-Versionen", [description, source, versions, list]);
    $("detail-body").scrollTop = scrollTop;
    if (focusedWorker) [...list.querySelectorAll("button")].find(button => button.dataset.skillWorker === focusedWorker)?.focus({ preventScroll: true });
  }
  function renderSkillVersions(devices) {
    const release = snapshot?.skillRelease;
    const items = latestSkills();
    const fresh = skillsFresh(release);
    const list = $("skill-version-list");
    const signature = JSON.stringify(items);
    if (list.dataset.signature !== signature) {
      const order = Object.keys(skillNames);
      list.replaceChildren(...items.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(item => {
        const row = node("li", "", skillNames[item.id] || item.id); row.title = item.id;
        row.append(node("strong", "", item.version)); return row;
      }));
      if (!items.length) list.append(node("li", "skill-version-empty", "Noch keine Versionsmeldung"));
      list.dataset.signature = signature;
    }
    $("skill-version-label").textContent = fresh ? "Skills · aktueller Stand" : "Skills · Stand ungeprüft";
    $("skill-version-label").title = release ? `RS-Skills · geprüft ${exact(release.checkedAt)}` : "Versionsmeldungen werden automatisch geladen.";
    const checked = devices.map(compareSkills);
    const current = checked.filter(item => item.state === "current").length;
    const pending = checked.some(item => item.state === "pending");
    const button = $("skill-version-compare");
    button.disabled = !items.length;
    button.textContent = items.length ? `Abgleich ${current}/${devices.length} ↗` : "Abgleichen";
    button.dataset.state = pending ? "pending" : checked.some(item => item.state === "unknown") ? "unknown" : "current";
    button.setAttribute("aria-label", `Skill-Versionen abgleichen: ${current} von ${devices.length} Macs aktuell`);
    if ($("detail-dialog").open && $("detail-title").textContent === "Skill-Versionen") skillDetails();
  }

  function render({ preserveScroll = false } = {}) {
    renderedDay = productionDay(Date.now());
    // WebKit can clamp the page offset while live regions are replaced.
    // Capture at render time so scrolling during the request stays intact.
    const scrollPosition = preserveScroll ? { left: window.scrollX, top: window.scrollY } : null;
    const items = tasks();
    const devices = machines();
    renderSkillVersions(devices);
    $("claude-account-summary").hidden = !snapshot;
    $("claude-account-count").textContent = snapshot ? numberFormat.format(claudeAccountCount(devices)) : "—";
    $("claude-account-summary").title = "Eingerichtete Claude-Accounts auf allen Macs. Zwei Worker-Accounts zählen als zwei; der zusätzliche Monitoring-Account wird nicht mitgezählt. Macs ohne Account-Meldung zählen nicht mit.";
    const attention = attentionEntries(devices, items);
    for (const [id, status] of [["nav-queue", "queued"], ["nav-running", "running"],
      ["nav-blocked", "blocked"], ["nav-clarification", "clarification"]]) {
      const count = snapshot ? items.filter(task => matchesStatus(task, status)).length : null;
      $(id).textContent = count == null ? "—" : numberFormat.format(count);
      $(id).dataset.tone = countTone(status, count);
    }
    $("nav-machines").textContent = snapshot ? numberFormat.format(devices.length) : "—";
    $("nav-attention").textContent = numberFormat.format(attention.length);
    $("nav-attention").hidden = !snapshot || !attention.length;
    $("log-attention-count").textContent = snapshot ? attention.length : "—";
    $("log-attention-count").dataset.tone = snapshot ? attention.length ? "bad" : "good" : "unknown";
    $("machine-count").textContent = devices.length;
    const queueTitle = statusNames[statusFilter] || ({ open: "Offene Aufgaben", all: "Alle Aufgaben" })[statusFilter] || "Aufgaben";
    $("queue-title").textContent = queueTitle;
    $("page-title").textContent =
      { overview: "Übersicht", queue: queueTitle, machines: "Macs", log: "Log", usage: "Verbrauch & Aufwand" }[view] || "Übersicht";
    document.querySelectorAll(".nav-item").forEach((button) => {
      const selected = button.dataset.view === view
        && (!button.dataset.status || button.dataset.status === statusFilter);
      button.classList.toggle("selected", selected);
      button.setAttribute(
        "aria-current",
        selected ? "page" : "false",
      );
    });
    $("overview-section").hidden = view !== "overview";
    $("machines-section").hidden = view !== "machines";
    $("queue-section").hidden = view !== "queue";
    $("log-section").hidden = view !== "log";
    if($("usage-section")) $("usage-section").hidden = view !== "usage";
    document.querySelectorAll("#status-tabs .tab").forEach((button) => {
      button.classList.toggle(
        "selected",
        button.dataset.status === statusFilter,
      );
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.status === statusFilter),
      );
    });
    document.querySelectorAll("#log-filters .tab").forEach((button) => {
      const selected = button.dataset.logFilter === logFilter;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("worker-filter").hidden = !workerFilter;
    $("worker-filter-label").textContent = `Aufgaben für ${workerName(workerFilter)}`;
    $("queue-period-filter").hidden = queuePeriod !== "today";
    $("queue-period-label").textContent = `Offen + heute abgeschlossen · ${productionDay(Date.now())}`;
    document.querySelectorAll("[data-pipeline-period]").forEach((button) => {
      const selected = button.dataset.pipelinePeriod === pipelinePeriod;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("team-label").textContent = credentials
      ? `Verbunden mit Team ${credentials.teamId} · ${location.host}`
      : "Jeder Mac nutzt dieselbe Team-ID mit eigenem Mitglieds-Token.";
    $("sync-status").title = credentials ? `Team ${credentials.teamId} · ${location.host}` : "";
    $("queue-updated").textContent = snapshot?.queue?.source?.lastSuccessAt
      ? `ClickUp · ${relative(snapshot.queue.source.lastSuccessAt)}`
      : "Quelle noch nicht verbunden";
    const selectedWorkflow = workflowFilter;
    $("workflow").replaceChildren(node("option", "", "Alle Workflows"));
    $("workflow").firstChild.value = "";
    const workflowValues = [
      ...new Set(items.map(workflowKey).filter(Boolean)),
    ].sort();
    if (selectedWorkflow && !workflowValues.includes(selectedWorkflow))
      workflowValues.push(selectedWorkflow);
    workflowValues.forEach((value) => {
      const option = node("option", "", workflow(value));
      option.value = value;
      $("workflow").append(option);
    });
    $("workflow").value = selectedWorkflow;
    if (snapshot) {
      renderMachines(devices);
      renderOverview(devices, items);
    }
    renderQueue(items);
    renderEvents(attention);
    refreshOpenTask();
    refreshMachineWork(devices);
    if (scrollPosition) window.scrollTo({ ...scrollPosition, behavior: "instant" });
  }
  function openQueue(status, workflowValue = "", period = "all") {
    queuePeriod = period;
    workerFilter = "";
    workflowFilter = workflowValue;
    query = "";
    $("search").value = "";
    selectView("queue", status);
    $("queue-heading").focus({ preventScroll: true });
  }
  function stageHead(label, short, stage) {
    const cell = node("th");
    cell.scope = "col";
    cell.title = label;
    const head = node("span", "stage-head");
    if (stage) head.dataset.stage = stage;
    head.append(node("span", "long", label), node("span", "short", short));
    head.lastChild.setAttribute("aria-hidden", "true");
    cell.append(head);
    return cell;
  }
  function stageCount(count, label, onOpen, stage) {
    const cell = node("td");
    if (!count) {
      cell.append(node("span", "stage-count zero", "0"));
      return cell;
    }
    const button = node("button", "stage-count", numberFormat.format(count));
    button.type = "button";
    if (stage) {
      button.dataset.stage = stage;
      button.dataset.tone = countTone(stage, count);
    }
    button.setAttribute("aria-label", `${label}: ${numberFormat.format(count)} Aufgaben anzeigen`);
    button.title = `${label}: ${numberFormat.format(count)}`;
    button.addEventListener("click", onOpen);
    cell.append(button);
    return cell;
  }
  // One row per workflow: Flows, Newsletter and Pop-ups of a workflow are summed
  // so the whole pipeline reads at a glance. Each count opens exactly its tasks.
  function pipelineRows(items) {
    const groups = new Map();
    for (const task of items) {
      const value = task.workflow || "";
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(task);
    }
    const order = (value) => pipelineOrder.includes(value) ? pipelineOrder.indexOf(value) : pipelineOrder.length;
    const label = (value) => workflowNames[value] || value || "Workflow";
    return [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b) || label(a).localeCompare(label(b), "de"))
      .map(([value, group]) => {
        const counts = new Map(stages.map(([key]) => [key, 0]));
        // The queue's Blockiert filter includes failures. Use the same bucket so
        // every count opens exactly its tasks, without counting failures twice.
        for (const task of group) {
          const key = stageOf(task) === "failed" ? "blocked" : stageOf(task);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        const open = group.filter(isOpen);
        const kinds = new Map();
        for (const task of open) {
          const kind = workflow(workflowKey(task)).split(" · ")[1];
          if (kind) kinds.set(kind, (kinds.get(kind) || 0) + 1);
        }
        return { value, name: label(value), counts, open: open.length, kinds };
      });
  }
  function renderPipeline(items) {
    items = tasksInPeriod(items, pipelinePeriod);
    const flows = pipelineRows(items);
    const open = items.filter(isOpen).length;
    const done = items.length - open;
    const unknown = items.filter(task => task.status === "completed" && !task.completedAt).length;
    const manual = items.filter(task => task.completion === "manual").length;
    $("pipeline-summary").textContent = snapshot
      ? `${pipelinePeriod === "today" ? productionDay(Date.now()) : `Gesamt · ${numberFormat.format(items.length)} Aufgaben`} · ${numberFormat.format(open)} offen · ${numberFormat.format(done)} ${pipelinePeriod === "today" ? "heute fertig" : "fertig"}${manual ? ` · davon ${manual} manuell erledigt` : ""}${unknown ? ` · davon ${unknown} ohne Abschlussdatum` : ""}`
      : "—";
    $("pipeline-summary").title = pipelinePeriod === "today"
      ? "Alle offenen Aufgaben und belegte Abschlüsse von heute · Tagesgrenze: Europe/Berlin. ClickUp-Änderungen verschieben keinen Abschluss."
      : "Alle Aufgaben: offen und fertig ergeben zusammen Gesamt. Fertig umfasst auch manuell erledigte Aufgaben und Abschlüsse ohne bekanntes Datum; diese zählen nur mit belegtem Datum als heute fertig.";
    if (!flows.length) {
      $("pipeline").replaceChildren(node("div", "empty-state", snapshot?.queue?.source?.lastSuccessAt
        ? pipelinePeriod === "today" && tasks().length
          ? "Keine offenen Aufgaben und keine belegten Abschlüsse von heute. Unter „Gesamt“ siehst du die gesamte Pipeline."
          : "Die Queue ist leer. Neue markierte Aufgaben erscheinen hier."
        : "Queue-Quelle noch nicht verbunden."));
      return;
    }
    const table = node("table", "pipeline-table");
    table.append(node("caption", "sr-only", "Pipeline je Workflow und Status"));
    const headRow = node("tr");
    const corner = node("th", "", "");
    corner.scope = "col";
    corner.append(node("span", "sr-only", "Workflow"));
    headRow.append(corner, stageHead("Offen", "Offen"));
    for (const [key, name] of stages) headRow.append(stageHead(name, stageShort[key], key));
    headRow.children[1].classList.add("open-total");
    headRow.lastChild.classList.add("done-total");
    const head = node("thead");
    head.append(headRow);
    const body = node("tbody");
    for (const { value, name, counts, open, kinds } of flows) {
      const row = node("tr");
      const title = node("th");
      title.scope = "row";
      const openFlow = node("button", "pipeline-flow", name);
      openFlow.type = "button";
      openFlow.dataset.workflow = value;
      openFlow.title = [`${name} · ${numberFormat.format(open)} offen`,
        ...[...kinds].map(([kind, count]) => `${kind}: ${numberFormat.format(count)} offen`)].join("\n");
      openFlow.setAttribute("aria-label", `${name}: alle ${numberFormat.format(open)} offenen Aufgaben anzeigen`);
      openFlow.addEventListener("click", () => openQueue("open", value, pipelinePeriod));
      title.append(openFlow);
      row.append(title);
      const total = stageCount(open, `${name} · offen`, () => openQueue("open", value, pipelinePeriod));
      total.className = "open-total";
      row.append(total);
      for (const [key, stageName, status] of stages) {
        const cell = stageCount(counts.get(key), `${name} · ${stageName}`,
          () => openQueue(status, value, pipelinePeriod), key);
        if (key === "completed") cell.className = "done-total";
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    $("pipeline").replaceChildren(table);
  }
  function machineAccount(machine) {
    return (machine.accounts || []).find((item) => item.accountId === machine.monitoringAccountId);
  }
  function isCodexRepair(machine) { return machine.workerKind === "codex-repair"; }
  function machineProviderLabel(machine) { return isCodexRepair(machine) ? "Codex" : "Claude"; }
  function machineWorkerLabel(machine) { return isCodexRepair(machine) ? "Codex Repair Worker" : "Newsletter-Worker"; }
  function claudeAccountCount(devices) {
    return devices.reduce((total, machine) => {
      // Worker slots are local to each Mac. Their IDs and display names are not
      // global identities; the separate monitoring login is not another slot.
      const accounts = machine.claudeAccounts?.accounts;
      if (accounts?.length) return total + accounts.length;
      return total + (machineAccount(machine)?.provider === "claude" ? 1 : 0);
    }, 0);
  }
  // Compact (overview rows): only states that need action; setup stays in the details.
  function accountActions(machine,{compact=false}={}) {
    const actions=node('div','account-actions');
    if(isCodexRepair(machine)) {
      if(!compact && !machine.monitoringAccountId) actions.append(node('small','form-hint','Codex auf diesem Mac anmelden. Wochenverbrauch und Reset werden danach automatisch gemeldet.'));
      return actions;
    }
    if(!compact && machine.claudeAccounts?.selectionReason)actions.append(node('small','form-hint',machine.claudeAccounts.selectionReason));
    const phase={installing:'Claude-Account wird eingerichtet…',figma_check:'Figma wird geprüft…',figma_login_required:'Figma-Anmeldung noch bestätigen'}[machine.accountProvisioning?.result?.status];
    if(phase)actions.append(node('small','form-hint',phase));
    if(!snapshot?.capabilities?.canManageClaudeAccounts || !machine.workerId)return actions;
    const full=machine.claudeAccounts?.accounts?.length>=2;
    if(!compact) {
      const button=node('button','text-button account-add-button',full ? '2 Claude-Accounts eingerichtet' : '+ Claude-Account');
      button.type='button';button.disabled=full || machine.agentStatus!=='online';
      button.title=full?'Beide Account-Plätze sind eingerichtet':!machine.accountProvisioning?'Account-Verwaltung auf diesem Mac prüfen':'Account auf diesem Mac hinzufügen';
      button.setAttribute('aria-label',full?`2 Claude-Accounts auf ${workerName(machine.workerId,machine.name)} eingerichtet`:`Claude-Account auf ${workerName(machine.workerId,machine.name)} hinzufügen`);
      button.addEventListener('click',event=>{event.stopPropagation();openAccountSetup(machine);});actions.append(button);
    }
    if(machine.accountProvisioning?.result?.status==='figma_login_required') {
      const figma=node('button','text-button','Figma verbinden');figma.type='button';
      figma.addEventListener('click',event=>{event.stopPropagation();openAccountSetup(machine,'connect-figma');});actions.append(figma);
    }
    return actions;
  }
  async function encryptedAccount(machine,body,action) {
    if(!crypto?.subtle)throw Error('Diese Ansicht benötigt HTTPS für die Account-Einrichtung.');
    const from64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
    const to64=value=>btoa(String.fromCharCode(...new Uint8Array(value)));
    const id=crypto.randomUUID(),endpoint=machine.accountProvisioning,expiresAt=new Date(Date.now()+15*60000).toISOString();
    const publicKey=await crypto.subtle.importKey('spki',from64(endpoint.publicKey),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const aad=new TextEncoder().encode([credentials.teamId,machine.workerId,machine.deviceId,id,action,expiresAt].join('|'));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,new TextEncoder().encode(JSON.stringify(body)));
    const wrappedKey=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,await crypto.subtle.exportKey('raw',key));
    return {id,action,expiresAt,keyId:endpoint.keyId,deviceId:machine.deviceId,iv:to64(iv),wrappedKey:to64(wrappedKey),ciphertext:to64(ciphertext)};
  }
  function openAccountSetup(machine,action='add-account') {
    if (!machine.accountProvisioning) {
      const label=workerName(machine.workerId,machine.name),panel=node('div','account-setup-form');
      const status=node('p','account-setup-status'),retry=node('button','button primary','Erneut prüfen');
      status.setAttribute('role','status');status.setAttribute('aria-live','polite');retry.type='button';
      const check=async()=>{
        retry.disabled=true;status.dataset.state='working';status.textContent=`Account-Verwaltung auf ${label} wird geprüft…`;
        try {
          const fleet=await consumptionRequest('/fleet');
          if(!panel.isConnected || !$('detail-dialog').open)return;
          const latest=fleet.machines?.find(item=>item.workerId===machine.workerId && item.deviceId===machine.deviceId);
          if(latest?.agentStatus==='online' && latest.accountProvisioning)return openAccountSetup(latest,action);
          status.dataset.state='warning';status.textContent=latest?.agentStatus==='online'
            ? `${label} hat die Account-Verwaltung noch nicht bestätigt. Der Mac richtet sie beim nächsten Abgleich automatisch ein. Danach erneut prüfen.`
            : `${label} ist gerade nicht erreichbar. Sobald der Mac wieder online ist, erneut prüfen.`;
        }catch(error){if(panel.isConnected){status.dataset.state='error';status.textContent=error.name==='TimeoutError'?'Der Mac-Abgleich antwortet nicht. Bitte erneut prüfen.':error.message;}}
        finally{retry.disabled=false;}
      };
      retry.addEventListener('click',check);panel.append(status,retry);
      openDetail(`Claude-Account hinzufügen · ${label}`,[panel]);check();return;
    }
    const label=workerName(machine.workerId,machine.name),form=node('form','account-setup-form');
    const intro=node('p','form-hint',action==='connect-figma'?`Figma wird auf ${label} geprüft und bei Bedarf im Browser verbunden.`:`Der zusätzliche Claude-Account wird auf ${label} eingerichtet. Die bestehende Anmeldung bleibt erhalten.`);
    const name=node('input'),primaryEmail=node('input'),token=node('input');
    name.id='claude-account-name';name.name='email';name.type='email';name.required=true;name.autocomplete='off';name.spellcheck=false;name.maxLength=160;name.placeholder='Zum Beispiel till2@ruegamer-steiner.de…';
    primaryEmail.id='claude-primary-email';primaryEmail.name='primaryEmail';primaryEmail.type='email';primaryEmail.required=true;primaryEmail.autocomplete='off';primaryEmail.spellcheck=false;primaryEmail.maxLength=160;primaryEmail.value=machineAccountIdentity(machine).email||'';
    token.id='claude-account-token';token.name='oauthToken';token.type='password';token.autocomplete='off';token.spellcheck=false;token.required=action==='add-account';token.placeholder='sk-ant-oat01-…';
    const nameLabel=node('label','','E-Mail des zusätzlichen Claude-Accounts');nameLabel.htmlFor=name.id;
    const primaryLabel=node('label','','E-Mail des bisherigen Claude-Accounts');primaryLabel.htmlFor=primaryEmail.id;
    const tokenLabel=node('label','','OAuth-Token');tokenLabel.htmlFor=token.id;
    const status=node('p','account-setup-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const submit=node('button','button primary',action==='connect-figma'?'Figma verbinden':'Account hinzufügen');submit.type='submit';
    const privacy=node('p','form-hint','Der Token wird nur auf dem ausgewählten Mac gespeichert. Figma wird anschließend automatisch geprüft.');
    const nameField=node('div','account-field'),primaryField=node('div','account-field'),tokenField=node('div','account-field');nameField.append(nameLabel,name);primaryField.append(primaryLabel,primaryEmail,node('small','form-hint','Bitte die E-Mail der bisherigen Claude-Anmeldung auf diesem Mac prüfen.'));tokenField.append(tokenLabel,token);
    form.append(intro,...(action==='add-account'?[primaryField,nameField,tokenField,privacy]:[]),status,submit);
    const messages={queued:`Wartet auf ${label}…`,installing:'Claude-Token wird auf dem Mac geprüft und gespeichert…',figma_check:'Figma-Verbindung wird auf dem Mac geprüft…',ready:'Bereit · Claude eingerichtet und Figma verbunden.',figma_login_required:`Claude ist eingerichtet. Figma-Anmeldung auf ${label} im geöffneten Browser bestätigen.`,expired:'Die Übertragung ist abgelaufen. Bitte erneut hinzufügen.',invalid_token:'Claude hat den Token nicht bestätigt. Vollständigen Token prüfen.',invalid_name:'Bitte gültige E-Mail-Adressen für beide Claude-Accounts angeben.',accounts_full:'Auf diesem Mac sind bereits zwei Accounts eingerichtet.',primary_missing:'Der bestehende Claude-Token fehlt auf dem Mac.',duplicate_account:'Dieser Token ist bereits eingerichtet.',keychain_locked:`Schlüsselbund auf ${label} entsperren und erneut versuchen.`,environment_override:'Auf dem Mac überschreibt eine Umgebungsvariable die Account-Auswahl.',configuration_error:'Claude-Einrichtung auf diesem Mac prüfen.',busy:'Auf dem Mac läuft bereits eine Account-Einrichtung.',failed:'Einrichtung nicht abgeschlossen. Den Mac prüfen und erneut versuchen.'};
    form.addEventListener('submit',async event=>{
      event.preventDefault();submit.disabled=true;status.dataset.state='working';
      let secret=token.value.replace(/\s/g,'');
      try {
        if(action==='add-account' && !/^sk-ant-oat01-[\w-]{80,}$/.test(secret))throw Error('Bitte einen vollständigen OAuth-Token einfügen.');
        status.textContent='Wird sicher an den ausgewählten Mac übertragen…';
        const envelope=await encryptedAccount(machine,action==='add-account'?{token:secret,name:name.value.trim(),primaryEmail:primaryEmail.value.trim()}:{},action);
        secret=null;token.value='';
        const route=`/workers/${encodeURIComponent(machine.workerId)}/claude-accounts`;
        const result=await consumptionRequest(route,'POST',envelope);let order=result.order;
        const until=Date.now()+4*60000;
        while(form.isConnected && $('detail-dialog').open && Date.now()<until) {
          status.textContent=messages[order?.status]||'Der Mac prüft die Einrichtung…';
          if(!['queued','installing','figma_check'].includes(order?.status))break;
          await new Promise(resolve=>setTimeout(resolve,2000));order=(await consumptionRequest(route)).order;
        }
        const pending=['queued','installing','figma_check'].includes(order?.status);
        status.dataset.state=order?.status==='ready'?'ready':order?.status==='figma_login_required' || pending?'warning':'error';
        if(pending)status.textContent='Der Mac hat noch keinen Abschluss bestätigt. Die Einrichtung läuft weiter. Den Status im Mac-Eintrag prüfen; den Token nicht erneut senden.';
        if(pending || ['ready','figma_login_required'].includes(order?.status)) {
          submit.hidden=true;name.disabled=true;token.disabled=true;nameField.hidden=true;tokenField.hidden=true;privacy.hidden=true;await refresh();
          const showMac=node('button','button secondary','Mac anzeigen');showMac.type='button';
          showMac.addEventListener('click',()=>{$('detail-dialog').close();selectView('machines');});form.append(showMac);
          if(order.status==='figma_login_required') {
            const reconnect=node('button','button secondary','Figma erneut verbinden');reconnect.type='button';reconnect.addEventListener('click',()=>openAccountSetup(machine,'connect-figma'));form.append(reconnect);
          }
        } else submit.disabled=false;
      }catch(error){status.textContent=error.message;status.dataset.state='error';submit.disabled=false;}
      finally{secret=null;token.value='';}
    });
    $('detail-dialog').addEventListener('close',()=>{token.value='';},{once:true});
    openDetail(`${action==='add-account'?'Claude-Account hinzufügen':'Figma verbinden'} · ${label}`,[form]);
  }
  function workerAccountColumn(machine, account) {
    const column = node("div", "worker-account-column");
    if (!account) { column.append(node("span", "usage-note", "Kein zweiter Account")); return column; }
    const stale = account.stale || !snapshot || Date.now()-Date.parse(account.updatedAt)>10*60000;
    const selected = machine.claudeAccounts?.selectedAccountId === account.id;
    const heading = node("div", "worker-account-heading");
    const identity = claudeAccountIdentity(account);
    const name = node("strong", "claude-account-name", identity.name);
    const item = fleetAccountLines(machine).find(line => line.id === account.id);
    markAccountAvailability(name, item);
    heading.append(name);
    if (selected && account.status==='ready' && !stale) heading.append(node("span", "worker-account-selected", "Nächster Start"));
    column.append(heading);
    const limits = node("div", "machine-limits");
    for (const [label,kind] of [["5 h","session"],["Woche","weekly"]]) {
      const window = account.windows.find(w=>w.kind===kind);
      const measurement = window ? {percent:window.percent,resetsAt:window.reset,usageUpdatedAt:account.updatedAt} : null;
      const limit = node("div", "machine-limit");
      limit.dataset.tone = percentTone(measurement?.percent,limitStale(measurement,stale));
      limit.title = limitTitle(measurement,stale);
      const line = node("div", "usage-line");
      line.append(node("span", "", `${label} genutzt`), node("strong", "", percentText(window?.percent)));
      limit.append(line,usageTrack(measurement?.percent),limitReset(measurement,stale));
      limits.append(limit);
    }
    column.append(limits);
    if(account.blockedUntil && !account.windows.some(w=>w.reset===account.blockedUntil))
      column.append(node("small","limit-reset",`Limit-Reset ${exact(account.blockedUntil)}`));
    const note = stale ? "Messung veraltet" : account.status==='limited' ? "Limit erreicht"
      : account.status==='error' ? "Account prüfen" : account.status==='unknown' ? "Wird geprüft…" : "";
    if(note) column.append(node("p","usage-note",note));
    return column;
  }
  function workerAccountsGrid(machine) {
    const grid = node("div","worker-accounts-grid");
    grid.setAttribute("aria-label","Claude-Accounts dieses Macs");
    for(const account of machine.claudeAccounts.accounts) grid.append(workerAccountColumn(machine,account));
    return grid;
  }
  function claudeAccountIdentity(account) {
    // Older Macs sent the email as the account name. Only use that fallback
    // when it is an address; a display name does not identify the login.
    const email = [account?.email, account?.name]
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
    return { email, name: email ? email.slice(0, email.indexOf('@')) : "E-Mail nicht hinterlegt" };
  }
  function machineAccountIdentity(machine) {
    if(machine.claudeAccounts?.accounts?.length===2) return {text:"2 Claude-Accounts · automatische Auswahl",title:"Accountnamen aus den E-Mail-Adressen; Kontingente direkt aus Claude Code",email:null};
    const account = machineAccount(machine);
    const { email, name } = claudeAccountIdentity(account);
    const provider = machineProviderLabel(machine);
    const displayName = isCodexRepair(machine) ? email ? name : account?.name || "Codex" : name;
    const text = !account ? `${provider} · kein Account verbunden` : `${provider} · ${displayName}`;
    const title = !account ? isCodexRepair(machine) ? "Codex auf diesem Worker-Mac anmelden" : "Monitoring-Account auf diesem Worker-Mac verbinden"
      : `${provider}-Account: ${email || account?.name || "E-Mail nicht gemeldet"}`;
    return { text, title, email };
  }
  function machineFigmaIdentity(machine) {
    const account = machine.figmaAccount;
    const email = typeof account?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) ? account.email : null;
    const verified=machine.accountProvisioning?.result?.figma==='connected';
    return { text: `Figma · ${email || (verified ? 'bei Einrichtung verbunden' : "noch nicht gemeldet")}`,
      title: email ? account.source === "mcp-whoami"
        ? `Direkt über die Figma-Verbindung dieses Macs bestätigt: ${email}\nGeprüft am ${exact(account.observedAt)}`
        : `Zuletzt vom Figma-Werkzeug auf diesem Mac gemeldet: ${email}\nLauf vom ${exact(account.observedAt)}`
        : "Noch keine erfolgreiche Figma-Account-Abfrage aus einem eigenen Lauf dieses Macs gemeldet" };
  }
  function machineLimit(machine, account, kind) {
    if (!account || !Array.isArray(machine.limits)) return null;
    return machine.limits.find((item) => item.accountId === account.accountId && item.kind === kind) || null;
  }
  // Everything this Mac accepted: running work first, then its fresh reservations
  // (the bridge only assigns a queued task to a worker while its claim is live).
  function activeTasks(machine) {
    if (machine.activity?.fresh) return (machine.activity.runs || []).slice()
      .sort((a, b) => (a.status !== "running") - (b.status !== "running"));
    return machine.workerId
      ? tasks().filter((task) => task.workerId === machine.workerId && ["running", "queued"].includes(task.status))
        .sort((a, b) => (a.status !== "running") - (b.status !== "running"))
      : [];
  }
  function blockedCorrections(machine) {
    return machine.workerId ? tasks().filter(task => task.workerId === machine.workerId
      && task.workflow === "correction" && ["blocked", "failed"].includes(task.status)) : [];
  }
  function blockedCorrectionLabel(items) {
    return `${items.length} ${items.length === 1 ? "Korrektur blockiert" : "Korrekturen blockiert"}`;
  }
  // Used places against the Mac maximum exactly as the worker counts them for
  // admission, also browser jobs, previews and transfers without a queue row.
  // Paused work waits outside the places. Only a current observation counts.
  function machineLoad(machine) {
    const load = machine.load;
    if (machine.status !== "online" || !load?.fresh || !Number.isInteger(load.occupied)) return null;
    const age = Date.now() - (timestamp(load.observedAt) || 0);
    return age <= (load.source === "agent" ? 45000 : 180000) ? load : null;
  }
  function loadText(load) {
    return Number.isInteger(load.max) ? `${load.occupied} / ${load.max}` : String(load.occupied);
  }
  function idleLabel(machine) {
    if (machine.status !== "online") return "—";
    const load = machineLoad(machine);
    if (load && Number.isInteger(load.max) && load.occupied >= load.max) return `voll belegt · ${loadText(load)}`;
    if (load?.occupied > 0) return `belegt · ${loadText(load)}`;
    if (machine.activity?.fresh && machine.activity.state === "idle") return machine.activity.acceptingTasks ? "frei" : "Annahme pausiert";
    if (machine.acceptingTasks === false) return "Annahme pausiert · Tätigkeit ungeprüft";
    return "Tätigkeit ungeprüft";
  }
  function batteryText(machine) {
    if (machine.batteryPercent == null) return ["—", ""];
    if (machine.nativeStatus && machine.nativeStatus !== "online") return ["—", "veraltet"];
    const source = machine.isCharging ? "lädt"
      : ["ac", "AC", "AC Power", "mains"].includes(machine.powerSource) ? "Netzteil"
        : machine.powerSource === "battery" ? "Akku" : "";
    return [percentText(machine.batteryPercent), source];
  }
  // Quotas report usage; battery reports remaining charge. Unknown is never zero.
  function percentTone(value, stale = false, remaining = false) {
    if (!Number.isFinite(value) || value < 0 || value > 100 || stale) return "unknown";
    if (remaining) return value <= 15 ? "bad" : value <= 30 ? "warn" : "good";
    return value >= 100 ? "bad" : value >= 80 ? "warn" : "good";
  }
  function batteryTone(machine) {
    const stale = machine.status !== "online" || (machine.nativeStatus && machine.nativeStatus !== "online");
    return percentTone(machine.batteryPercent, stale, true);
  }
  function limitStale(limit, stale = false) {
    const updatedAt = timestamp(limit?.usageUpdatedAt);
    return Boolean(stale || limit?.usageStale || limit?.usageError || limit?.usageStatus === "error"
      || (updatedAt && Date.now() - updatedAt > 15 * 60000));
  }
  function countTone(status, count) {
    if (!Number.isFinite(count)) return "unknown";
    if (["blocked", "failed", "clarification"].includes(status) && count === 0) return "good";
    if (count === 0) return "unknown";
    return ({ online: "good", completed: "good", queued: "warn", paused: "warn", silent: "warn",
      blocked: "bad", failed: "bad", offline: "bad", running: "info", clarification: "clarification" })[status] || "unknown";
  }
  function limitTitle(limit, stale) {
    const value = limit?.percent;
    const displayed = displayPercent(value);
    if (displayed === null) return "Noch keine Kontingent-Messung";
    return `${percentText(value)} genutzt · ${limitStale(limit, stale) ? "Messung veraltet"
      : value >= 100 ? "Limit ausgeschöpft" : `${percentText(100 - displayed)} verfügbar`}`;
  }
  function usageTrack(value) {
    const track = node("div", "usage-track");
    const fill = node("div", "usage-fill");
    fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
    track.append(fill);
    return track;
  }

  // Always show each window's own reported reset, regardless of utilization.
  function limitReset(limit, stale) {
    const resetsAt = timestamp(limit?.resetsAt);
    const text = resetsAt === null ? "Reset unbekannt"
      : `Reset ${resetFormat.format(resetsAt).replace(/^(\S+)\., /, "$1 ").replace(", ", " ")}`;
    const note = node("small", "limit-reset", text);
    note.title = resetsAt === null ? "Noch kein Reset-Zeitpunkt gemeldet"
      : `Gemeldeter Reset: ${exact(limit.resetsAt)}`;
    if (resetsAt !== null && resetsAt <= Date.now()) note.title += " · Neue Messung ausstehend";
    if (limitStale(limit, stale)) note.title += " · Messung veraltet";
    return note;
  }

  // Overview lines keep the reset next to the value: weekday and time within
  // the coming week, the date beyond it. The tooltip keeps the exact time.
  function shortReset(resetsAt) {
    const parts = Object.fromEntries(resetPartsFormat.formatToParts(resetsAt).map(({ type, value }) => [type, value]));
    return resetsAt - Date.now() < 6 * 86400000
      ? `${parts.weekday.replace(/\.$/, "")} ${parts.hour}:${parts.minute}` : `${parts.day}.${parts.month}.`;
  }
  function meter(limit, stale) {
    const value = limit?.percent ?? null;
    const outdated = limitStale(limit, stale);
    const wrap = node("div", `meter${value == null ? " unknown" : ""}${outdated && value != null ? " stale" : ""}`);
    wrap.dataset.tone = percentTone(value, outdated);
    const number = node("b", "", percentText(value));
    number.dataset.tone = wrap.dataset.tone;
    const reset = limitReset(limit, stale);
    const resetsAt = timestamp(limit?.resetsAt);
    reset.textContent = resetsAt === null ? "—" : shortReset(resetsAt);
    wrap.title = `${limitTitle(limit, stale)}\n${reset.title}`;
    reset.removeAttribute("title");
    wrap.append(usageTrack(value), number, reset);
    return wrap;
  }
  function sortedMachines(devices) {
    const ranked = devices.map((machine) => {
      const account = machineAccount(machine);
      const selected=machine.claudeAccounts?.accounts.find(a=>a.id===machine.claudeAccounts.selectedAccountId);
      const weekly = selected ? selected.windows.find(w=>w.kind==='weekly') : machineLimit(machine, account, "weekly");
      const session = selected ? selected.windows.find(w=>w.kind==='session') : machineLimit(machine, account, "session");
      const percent = (limit) => Number.isFinite(limit?.percent) && limit.percent >= 0
        ? limit.percent : Infinity;
      const hasError = Boolean(workerFailureReason(machine) || machine.usageError ||
        machine.usageStatus === "error" ||
        ["failed", "blocked", "offline", "silent"].includes(machineDisplayStatus(machine)));
      // The weekly cap always comes last, even when that worker also has errors.
      const rank = Number.isFinite(weekly?.percent) && weekly.percent >= 100 ? 2
        : hasError ? 0 : 1;
      return { machine, rank, weekly: percent(weekly), session: percent(session) };
    });
    return ranked.sort((a, b) =>
      a.rank - b.rank || a.weekly - b.weekly || a.session - b.session ||
      workerName(a.machine.workerId, a.machine.name).localeCompare(
        workerName(b.machine.workerId, b.machine.name), "de", { numeric: true }) ||
      String(a.machine.deviceId || "").localeCompare(String(b.machine.deviceId || ""))
    ).map(({ machine }) => machine);
  }
  // Overview rows mark the power source with an icon; the tooltip names it.
  const powerIcons = { Netzteil: "M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0zM8 11.5v2.5",
    lädt: "M9 1.5 4 9h4l-1 5.5L12 7H8z" };
  function lineIcon(path, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add(className);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", path);
    svg.append(line);
    return svg;
  }
  // One line per Claude account. The account, 5 h and week columns stack the
  // same accounts in the same order, so every line reads straight across.
  function accountAvailability(session, weekly, stale, status, blockedUntil, optionalWindows = false) {
    const required = optionalWindows ? [session, weekly].filter(Boolean) : [session, weekly];
    if (stale || required.some(limit => limitStale(limit)))
      return { available: false, availability: "Kontingent nicht bestätigt · Messung veraltet" };
    if (status === "error") return { available: false, availability: "Kontingent nicht bestätigt · Account prüfen" };
    if (status === "limited" || timestamp(blockedUntil) > Date.now()
      || required.some(limit => limit?.percent >= 100))
      return { available: false, availability: "Kein freies Kontingent · Limit erreicht" };
    if (!required.length || status === "unknown" || required.some(limit =>
      !Number.isFinite(limit?.percent) || limit.percent < 0 || limit.percent > 100
      || (timestamp(limit.resetsAt) !== null && timestamp(limit.resetsAt) <= Date.now())))
      return { available: false, availability: "Kontingent noch nicht bestätigt" };
    return { available: true, availability: "Freies Kontingent" };
  }
  function markAccountAvailability(element, item) {
    if (!item) return;
    element.dataset.available = String(item.available);
    element.title = item.title;
    element.setAttribute("aria-label", `${item.name} · ${item.availability}${item.next ? " · nächster Start" : ""}`);
  }
  function fleetAccountLines(machine) {
    const pool = machine.claudeAccounts?.accounts;
    if (pool?.length === 2) return pool.map((account) => {
      const stale = account.stale || !snapshot || !timestamp(account.updatedAt)
        || Date.now() - timestamp(account.updatedAt) > 10 * 60000;
      const identity = claudeAccountIdentity(account);
      const next = machine.claudeAccounts.selectedAccountId === account.id && account.status === "ready" && !stale;
      const note = stale ? "Messung veraltet" : account.status === "limited" ? "Limit erreicht"
        : account.status === "error" ? "Account prüfen" : account.status === "unknown" ? "Wird geprüft…" : "";
      const blocked = account.blockedUntil && !account.windows.some(w => w.reset === account.blockedUntil)
        ? `Limit-Reset ${exact(account.blockedUntil)}` : "";
      const limit = (kind) => {
        const window = account.windows.find(w => w.kind === kind);
        return window ? { percent: window.percent, resetsAt: window.reset, usageUpdatedAt: account.updatedAt } : null;
      };
      const session = limit("session"), weekly = limit("weekly");
      const availability = accountAvailability(session, weekly, stale, account.status, account.blockedUntil);
      return { id: account.id, name: identity.name, next, stale, note: note || blocked, ...availability,
        tone: account.status === "error" && !stale ? "bad" : blocked ? "warn" : "unknown",
        title: [identity.email || identity.name, availability.availability, next ? "Nächster Start" : "", note, blocked].filter(Boolean).join("\n"),
        session, weekly };
    });
    const account = machineAccount(machine);
    if (!account) return [];
    const identity = claudeAccountIdentity(account);
    const stale = usageStale(machine) || Boolean(machine.usageError);
    const session = machineLimit(machine, account, "session"), weekly = machineLimit(machine, account, "weekly");
    const availability = accountAvailability(session, weekly, stale, machine.codexAccount?.status, undefined, isCodexRepair(machine));
    return [{ name: isCodexRepair(machine) ? `Codex · ${identity.email ? identity.name : account.name || "Account"}` : identity.name, next: false, stale, note: "", ...availability,
      title: [`${machineProviderLabel(machine)}-Account: ${identity.email || account.name || "E-Mail nicht gemeldet"}`,
        availability.availability, machine.usageError || "",
        stale ? `Letzte Messung ${relative(machine.usageUpdatedAt)}` : ""].filter(Boolean).join("\n"),
      session, weekly }];
  }
  function renderFleet(devices) {
    const online = devices.filter((machine) => machine.status === "online").length;
    const affected = devices.filter(machine => workerFailureReason(machine)).length;
    const onlineCount = node("span", "", `${numberFormat.format(online)} von ${numberFormat.format(devices.length)} online`);
    onlineCount.dataset.tone = devices.length ? online === devices.length ? "good" : online ? "warn" : "bad" : "unknown";
    $("fleet-summary").replaceChildren(onlineCount);
    if (affected) {
      const errors = node("span", "", `${numberFormat.format(affected)} mit Worker-Störung`);
      errors.dataset.tone = "bad";
      $("fleet-summary").append(" · ", errors);
    }
    $("fleet-dots").replaceChildren(...sortedMachines(devices).map((machine) => node("span", `dot ${machineDisplayStatus(machine)}`)));
    if (!devices.length) {
      const row = node("tr");
      const cell = node("td", "empty-state", "Noch kein Mac erfasst. Verbinde Max Monitor auf jedem Mac mit diesem Team-Server.");
      cell.colSpan = 7;
      row.append(cell);
      $("fleet-body").replaceChildren(row);
      return;
    }
    $("fleet-body").replaceChildren(...sortedMachines(devices).map((machine) => {
      const displayStatus = machineDisplayStatus(machine);
      const failure = workerFailureReason(machine);
      const row = node("tr", `fleet-row ${displayStatus}`);
      const label = workerName(machine.workerId, machine.name);
      const nameCell = node("td");
      const name = node("div", "fleet-name");
      const signal = node("span", `dot ${displayStatus}`);
      signal.title = statusNames[displayStatus] || "Unbekannt";
      const identity = node("span");
      const open = node("button", "", label);
      const swatch = workerSwatch(machine.workerId);
      if (swatch) open.prepend(swatch);
      open.type = "button";
      open.title = label;
      open.setAttribute("aria-label", `${label} · ${statusNames[displayStatus] || "Unbekannt"} · Details`);
      const deviceName = machine.deviceName || (machine.name !== machine.workerId ? machine.name : null);
      // Account, Figma and selection details stay one hover away; the row
      // itself only grows for states that need action.
      const accountIdentity = machineAccountIdentity(machine);
      const figmaIdentity = machineFigmaIdentity(machine);
      open.title = [label, deviceName && deviceName !== label ? `macOS: ${deviceName}` : "",
        accountIdentity.text, machine.claudeAccounts?.selectionReason || "", figmaIdentity.text].filter(Boolean).join("\n");
      identity.append(open);
      if (isCodexRepair(machine)) identity.append(node("small", "", "Codex Repair"));
      if (!machine.workerId) identity.append(node("small", "", "ohne Worker-ID"));
      const actions = accountActions(machine, { compact: true });
      if (actions.childElementCount) identity.append(actions);
      name.append(signal, identity);
      nameCell.append(name);
      const active = activeTasks(machine);
      const taskCell = node("td", "fleet-work");
      const line = node("span", "fleet-task-line");
      if (active.length) line.append(taskKindBadge(active[0]));
      const current = node("span", failure ? "fleet-task fleet-issue" : active.length ? "fleet-task" : "fleet-task idle",
        failure || (active.length ? active[0].title || active[0].id : idleLabel(machine)));
      if (failure) current.title = machineAttentionReasons(machine).join("\n");
      if (active.length && !failure) current.title = active.map((task) => task.title || task.id).join("\n");
      line.append(current);
      const load = machineLoad(machine);
      const more = [active.length > 1 ? `+${active.length - 1}` : "", load && active.length ? loadText(load).replace(/ /g, "") : ""].filter(Boolean).join(" · ");
      if (more) {
        const extra = node("span", "fleet-more", more);
        extra.title = [active.length > 1 ? `${active.length - 1} weitere Aufgaben` : "", load && active.length ? `Belegte Plätze ${loadText(load)}` : ""].filter(Boolean).join(" · ");
        line.append(extra);
      }
      taskCell.append(line);
      if (failure && active.length) taskCell.append(node("span", "fleet-sub", `Zuletzt: ${active[0].title || active[0].id}`));
      else if (active[0]?.status === "queued") taskCell.append(node("span", "fleet-sub", "reserviert · startet gleich"));
      const blocked = blockedCorrections(machine);
      if (blocked.length) {
        const summary = node("span", "fleet-sub fleet-issue", blockedCorrectionLabel(blocked));
        summary.title = blocked.map(task => `${task.title}: ${task.blockedReason || task.phase}`).join("\n");
        taskCell.append(summary);
      }
      const [battery, source] = batteryText(machine);
      const batteryCell = node("td", "fleet-battery");
      batteryCell.dataset.tone = batteryTone(machine);
      batteryCell.title = source === "veraltet" ? "Keine aktuelle Akku-Messung der Mac-App"
        : battery === "—" ? "Akku noch nicht gemeldet" : `Akku: ${battery}${source ? ` · ${source}` : ""}`;
      const power = powerIcons[source];
      if (power) batteryCell.append(lineIcon(power, "power-icon"));
      batteryCell.append(battery);
      if (source === "veraltet") batteryCell.append(node("small", "", " · veraltet"));
      const accountCell = node("td", "fleet-accounts");
      const lines = fleetAccountLines(machine);
      if (lines.length > 1) accountCell.classList.add("pool");
      const sessionCell = node("td", "fleet-limits");
      const weeklyCell = node("td", "fleet-limits");
      if (lines.length) {
        for (const item of lines) {
          const accountName = node("span", `fleet-account-name${item.next ? " next" : ""}`, item.name);
          markAccountAvailability(accountName, item);
          if (item.note) accountName.dataset.tone = item.tone;
          accountCell.append(accountName);
          sessionCell.append(meter(item.session, item.stale));
          weeklyCell.append(meter(item.weekly, item.stale));
        }
      } else {
        const unbound = node("span", "fleet-unbound", isCodexRepair(machine) ? "Codex anmelden" : "kein Account");
        unbound.title = machineAccountIdentity(machine).title;
        accountCell.append(unbound);
        sessionCell.append(node("span", "fleet-unbound", "—"));
        weeklyCell.append(node("span", "fleet-unbound", "—"));
      }
      const seenAt = machine.lastSeenAt || machine.receivedAt || machine.seenAt;
      const seen = node("td", "fleet-seen", relative(seenAt).replace(/^vor /, ""));
      seen.title = exact(seenAt);
      row.append(nameCell, taskCell, batteryCell, accountCell, sessionCell, weeklyCell, seen);
      row.addEventListener("click", () => machineDetails(machine));
      return row;
    }));
  }
  function renderOverview(devices, items) {
    renderPipeline(items);
    renderFleet(devices);
  }
  function renderMachines(devices) {
    $("machine-grid").replaceChildren();
    if (!devices.length) {
      $("machine-grid").append(
        node(
          "div",
          "empty-state",
          "Noch kein Mac erfasst. Verbinde Max Monitor auf jedem Mac mit diesem Team-Server.",
        ),
      );
      return;
    }
    sortedMachines(devices).forEach((machine) => {
      const displayStatus = machineDisplayStatus(machine);
      const card = node("article", `machine ${displayStatus}`);
      const title = node("div", "machine-title");
      const identity = node("div", "machine-name");
      const label = workerName(machine.workerId, machine.name);
      const machineName = node("h3", "", label);
      const swatch = workerSwatch(machine.workerId);
      if (swatch) machineName.prepend(swatch);
      machineName.title = label;
      const deviceName = machine.deviceName || (machine.name !== machine.workerId ? machine.name : null);
      const subtitle = node("small", "", isCodexRepair(machine) ? "Codex Repair Worker" : !machine.workerId ? "Worker-ID nicht zugeordnet"
        : deviceName ? `macOS: ${deviceName}` : "Wie in Slack");
      subtitle.title = subtitle.textContent;
      identity.append(machineName, subtitle);
      const signal = badge(displayStatus);
      if (machine.telemetrySource === "worker" && displayStatus === machine.status)
        signal.textContent = `Worker ${statusNames[machine.status]?.toLowerCase() || machine.status}`;
      title.append(identity, signal);
      const data = node("div", "machine-data");
      const [battery, source] = batteryText(machine);
      const active = activeTasks(machine);
      const load = machineLoad(machine);
      const seenAt = machine.lastSeenAt || machine.receivedAt || machine.seenAt;
      for (const [name, value, hint, tooltip] of [
        ["Akku", battery, source === "Akku" ? "" : source],
        load ? ["Plätze", loadText(load), Number.isInteger(load.max) && load.occupied >= load.max ? "voll" : "", "Belegte Plätze / Maximum dieses Macs"]
          : ["Aufgaben", active.length || machine.activity?.fresh ? `${active.length} aktiv` : "ungeprüft", ""],
        ["Meldung", relative(seenAt).replace(/^vor /, ""), "", exact(seenAt)],
      ]) {
        const datum = node("div");
        const text = node("span", "datum-value", value);
        if (name === "Akku") {
          text.dataset.tone = batteryTone(machine);
          text.title = source === "veraltet" ? "Keine aktuelle Akku-Messung der Mac-App"
            : battery === "—" ? "Akku noch nicht gemeldet" : `Akku: ${battery}${source ? ` · ${source}` : ""}`;
        }
        if (name === "Meldung") text.dataset.tone = countTone(machine.status, 1);
        if (hint) text.append(node("small", "", ` · ${hint}`));
        if (tooltip) text.title = tooltip;
        datum.append(node("span", "datum-label", name), text);
        data.append(datum);
      }
      card.append(title, data);
      const blocked = blockedCorrections(machine);
      if (blocked.length) {
        const summary = node("p", "usage-note fleet-issue", blockedCorrectionLabel(blocked));
        summary.title = blocked.map(task => `${task.title}: ${task.blockedReason || task.phase}`).join("\n");
        card.append(summary);
      }
      const failure = workerFailureReason(machine);
      if (failure) card.append(node("p", "usage-note fleet-issue", failure));
      else {
        const warning = workerIssues(machine).find(issue => issue.severity === "warning");
        if (warning) card.append(node("p", "usage-note", workerIssueReason(warning)));
      }
      const account = machineAccount(machine);
      const accountIdentity = machineAccountIdentity(machine);
      const accountLabel = node("p", account ? "machine-account" : "machine-account unbound", accountIdentity.text);
      accountLabel.title = accountIdentity.title;
      if (account && machine.claudeAccounts?.accounts?.length !== 2) {
        accountLabel.classList.add("claude-account-name");
        markAccountAvailability(accountLabel, fleetAccountLines(machine)[0]);
      }
      card.append(accountLabel);
      card.append(accountActions(machine));
      const figmaIdentity = machineFigmaIdentity(machine);
      const figmaLabel = node("p", "machine-account machine-figma-account", figmaIdentity.text);
      figmaLabel.title = figmaIdentity.title;
      card.append(figmaLabel);
      if (machine.claudeAccounts?.accounts?.length===2) {
        accountLabel.textContent = "2 Claude-Accounts · automatische Auswahl";
        card.append(workerAccountsGrid(machine));
      } else if (account) {
        const limitGroup = node("div", "machine-limits");
        const stale = usageStale(machine) || Boolean(machine.usageError);
        const outdatedLabels = [];
        for (const [name, kind] of [[isCodexRepair(machine) ? "Sitzung" : "5 h", "session"], ["Woche", "weekly"]]) {
          const measurement = machineLimit(machine, account, kind);
          const value = measurement?.percent ?? null;
          const outdated = limitStale(measurement, stale);
          if (measurement && outdated) outdatedLabels.push(name);
          const limit = node("div", "machine-limit");
          limit.dataset.tone = percentTone(value, outdated);
          limit.title = limitTitle(measurement, stale);
          const line = node("div", "usage-line");
          const number = node("strong", "", percentText(value));
          number.dataset.tone = limit.dataset.tone;
          line.append(node("span", "", `${name} genutzt`), number);
          limit.append(line, usageTrack(value));
          limit.append(limitReset(measurement, stale));
          limitGroup.append(limit);
        }
        card.append(limitGroup);
        const limits = machine.limits || [];
        if (!limits.length || outdatedLabels.length || machine.usageError)
          card.append(node("p", "usage-note", machine.usageError ||
            (!limits.length ? `${machineProviderLabel(machine)}-Kontingente noch nicht gemeldet.`
              : stale ? `Kontingente veraltet · ${relative(machine.usageUpdatedAt)}`
                : `Messung veraltet: ${outdatedLabels.join(", ")}`)));
      }
      if (machine.workerStatus && machine.workerStatus !== "online")
        card.append(node("p", "usage-note",
          `${machineWorkerLabel(machine)}: ${statusNames[machine.workerStatus] || machine.workerStatus} · ${relative(machine.workerLastSeenAt)}`));
      const bottom = node("div", "machine-bottom");
      const current = node("span", "machine-current", active.length
        ? `${active[0].status === "queued" ? "Reserviert: " : ""}${active[0].title || active[0].id}` : idleLabel(machine));
      current.title = current.textContent;
      if (active.length) current.prepend(taskKindBadge(active[0]), " ");
      const detail = node("button", "text-button", "Details ↗");
      detail.setAttribute("aria-label", `Details für ${label}`);
      detail.addEventListener("click", () => machineDetails(machine));
      bottom.append(current, detail);
      card.append(bottom);
      $("machine-grid").append(card);
    });
  }
  function filtered(items, { ignoreStatus = false } = {}) {
    const workerNames = new Map(machines().filter(machine => machine.workerId).map(machine => [machine.workerId, [workerName(machine.workerId, machine.name), machine.deviceName].filter(Boolean).join(" ")]));
    const needle = query.trim().toLocaleLowerCase();
    return tasksInPeriod(items, queuePeriod)
      .filter((task) => {
        if (
          !ignoreStatus && !matchesStatus(task, statusFilter)
        )
          return false;
        if (workerFilter && task.workerId !== workerFilter) return false;
        if (!matchesWorkflow(task, workflowFilter)) return false;
        return (
          !needle ||
          [task.title, task.id, task.company, task.pmOwner, task.workerId, workerName(task.workerId, ""), workerNames.get(task.workerId), task.url, task.blockedReason, task.phase, task.step, ...(task.tags || [])]
            .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle)
        );
      })
      .sort(
        (a, b) =>
          (({ running: 0, blocked: 1, failed: 2, clarification: 3, paused: 4, queued: 5, completed: 6 })[
            a.status
          ] ?? 5) -
            ({ running: 0, blocked: 1, failed: 2, clarification: 3, paused: 4, queued: 5, completed: 6 }[
              b.status
            ] ?? 5) || String(a.title).localeCompare(String(b.title)),
      );
  }
  function canComplete(task) {
    return task && !task.errorUrl && ["blocked", "failed"].includes(task.status) && task.taskVersion;
  }
  function completionButton(task, expanded = false) {
    const button = node("button", expanded ? "button secondary complete-task" : "icon-button complete-task");
    button.type = "button";
    const icon = node("span", "", "✓");
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    if (expanded) button.append(node("span", "", "Als erledigt abhaken"));
    button.title = "Als erledigt abhaken";
    button.setAttribute("aria-label", `Als erledigt abhaken: ${task.title || task.id}`);
    button.disabled = completingTasks.has(task.id);
    button.setAttribute("aria-busy", String(button.disabled));
    button.addEventListener("click", () => completeTask(task));
    return button;
  }
  async function completeTask(task) {
    if (!credentials || completingTasks.has(task.id)) return;
    const connection = credentials;
    completingTasks.add(task.id);
    $("task-action-status").hidden = true;
    $("detail-action-error").hidden = true;
    render();
    $("detail-body").querySelectorAll(".complete-task").forEach((button) => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${relayPrefix}/v1/teams/${encodeURIComponent(connection.teamId)}/fleet/tasks/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, taskVersion: task.taskVersion }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Abhaken fehlgeschlagen. Versuche es erneut.");
      if (connection !== credentials) return;
      // Abort older reads so they cannot put the just-completed task back.
      stopLive();
      generation += 1;
      fetchController?.abort();
      busy = false;
      if (snapshot) snapshot.queue.tasks = snapshot.queue.tasks.map((entry) => entry.id === task.id ? data.task : entry);
      $("detail-dialog").close();
      render();
      $(view === "log" ? "log-heading" : view === "queue" ? "queue-heading" : "main").focus({ preventScroll: true });
      await refresh();
    } catch (error) {
      if (connection !== credentials) return;
      const message = error.name === "AbortError"
        ? "Abhaken konnte nicht bestätigt werden. Aktualisiere die Ansicht und versuche es erneut."
        : `${error.message} Aktualisiere die Ansicht und versuche es erneut.`;
      $("task-action-status").textContent = message;
      $("task-action-status").hidden = false;
      $("detail-action-error").textContent = message;
      $("detail-action-error").hidden = !$("detail-dialog").open;
    } finally {
      clearTimeout(timeout);
      completingTasks.delete(task.id);
      if (connection === credentials) {
        render();
        $("detail-body").querySelectorAll(".complete-task").forEach((button) => {
          button.disabled = false;
          button.setAttribute("aria-busy", "false");
        });
      }
    }
  }
  function renderQueue(items) {
    const scoped = filtered(items, { ignoreStatus: true });
    const statusCounts = { open: scoped.filter(isOpen).length, all: scoped.length };
    for (const status of ["marked", "running", "queued", "paused", "clarification", "blocked", "completed"]) statusCounts[status] = scoped.filter(task => matchesStatus(task, status)).length;
    for (const [status, count] of Object.entries(statusCounts)) {
      const label = $(`${status}-count`);
      if (label) {
        label.textContent = numberFormat.format(count);
        label.dataset.tone = countTone(status, snapshot ? count : null);
      }
    }
    const visible = filtered(items);
    $("queue-count").textContent = snapshot ? numberFormat.format(visible.length) : "—";
    $("queue-count").dataset.tone = countTone(statusFilter, snapshot ? visible.length : null);
    const body = $("queue-body");
    body.replaceChildren();
    queuePage = Math.min(
      queuePage,
      Math.max(0, Math.ceil(visible.length / pageSize) - 1),
    );
    const pageTasks = visible.slice(
      queuePage * pageSize,
      (queuePage + 1) * pageSize,
    );
    $("pagination").hidden = visible.length <= pageSize;
    $("page-label").textContent =
      `Seite ${queuePage + 1} / ${Math.max(1, Math.ceil(visible.length / pageSize))}`;
    $("page-previous").disabled = queuePage === 0;
    $("page-next").disabled = (queuePage + 1) * pageSize >= visible.length;
    $("queue-empty").hidden = visible.length > 0;
    $("queue-empty").textContent = !snapshot
      ? "Verbinde den Team-Server, um die vollständige Queue zu laden."
      : items.length === 0 && !snapshot.queue.source?.lastSuccessAt
        ? "Queue-Quelle noch nicht verbunden. Richte die Newsletter-Brücke ein, um offene ClickUp-Aufgaben zu sehen."
        : statusFilter === "clarification"
          ? items.some(task => matchesStatus(task, "clarification"))
            ? "Keine PM-Rückfragen für diese Filter. Entferne die Suche oder Filter, um alle PM-Rückfragen zu sehen."
            : "Aktuell sind keine PM-Rückfragen offen."
          : "Keine Aufgaben für diesen Filter.";
    $("result-count").textContent = snapshot
      ? `${visible.length} von ${items.length} Aufgaben`
      : "Noch keine Queue-Daten";
    pageTasks.forEach((task) => {
      const row = node("tr");
      const titleCell = node("td");
      const url = safeLink(task.url);
      const drafts = task.previews?.length || 0;
      // With drafts the name opens them; ClickUp and Figma stay in the actions.
      const title = node(
        drafts ? "button" : url ? "a" : "span",
        "task-title",
        task.title || task.id,
      );
      title.title = task.title || task.id;
      if (drafts) {
        title.type = "button";
        title.setAttribute("aria-label", `Entwürfe ansehen: ${task.title || task.id}`);
        title.addEventListener("click", () => taskDetails(task));
      } else if (url) {
        title.href = url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }
      titleCell.append(title);
      const scope = task.workflow === "correction" ? /-file-[a-f0-9]{31,32}$/.test(task.id) ? "Mail-Korrektur" : "Vorbereitung" : null;
      if (task.company || drafts || scope) {
        const company = node("span", "task-company", task.company || "");
        company.title = task.company || "";
        if (scope) company.append(node("span", "", `${task.company ? " · " : ""}${scope}`));
        if (drafts) company.append(node("span", "task-drafts",
          `${task.company ? " · " : ""}${drafts === 1 ? "Entwurf" : `${drafts} Entwürfe`}`));
        titleCell.append(company);
      }
      if (stageOf(task) === "clarification") {
        titleCell.append(node("span", "pm-owner", `Wartet auf: ${task.pmOwner || "PM in Slack noch nicht bestätigt"}`));
      }
      titleCell.append(node("span", "task-id", task.id));
      if (task.status === "completed") titleCell.append(node("span", "task-completion-time",
        task.completedAt ? `Abgeschlossen ${exact(task.completedAt)}` : "Abschlussdatum unbekannt"));
      const category = node("td");
      const workflowLabel = node("span", "workflow-name", workflow(task));
      workflowLabel.dataset.workflow = task.workflow || "";
      workflowLabel.title = workflowLabel.textContent;
      category.append(workflowLabel);
      const state = node("td");
      const status = badge(stageOf(task));
      status.lastChild.textContent = completionLabel(task);
      state.append(status);
      const assigned = node("td");
      const assignment = node("div", "progress");
      assignment.append(
        node("span", "", runningPackage(task)
          ? `Paket: ${workerName(runningPackage(task).workerId)}` : workerName(task.workerId, "Noch nicht zugewiesen")),
      );
      if (Number.isFinite(task.progress)) {
        const track = node("div", "usage-track");
        const fill = node("div", "usage-fill");
        fill.style.width = `${Math.min(100, Math.max(0, task.progress))}%`;
        track.append(fill);
        assignment.append(track, node("span", "", percentText(task.progress)));
      }
      assigned.append(assignment);
      // The worker's live step replaces the generic "In Bearbeitung".
      if (packageHint(task) || task.blockedReason || task.step || task.phase) {
        const phase = node("span", task.blockedReason ? "phase blocked-reason" : "phase", packageHint(task) || task.blockedReason || task.step || task.phase);
        phase.title = phase.textContent;
        assigned.append(phase);
      }
      const updated = node("td");
      const stamp = task.status === "completed" ? task.completedAt : task.updatedAt;
      const time = node("time", "row-time", stamp ? relative(stamp) : "Datum unbekannt");
      time.title = `${task.status === "completed" ? "Abschluss" : "Aktualisiert"}: ${exact(stamp)}`;
      if (timestamp(stamp)) time.dateTime = stamp;
      updated.append(time);
      const actions = node("td");
      const actionGroup = node("div", "queue-actions");
      const links = node("div", "task-links");
      for (const [label, value] of [["Slack", task.errorUrl], [task.workflow === "sales" ? "Shop" : "ClickUp", task.url], ["Mail", task.mailUrl], ["Figma", task.figmaUrl]]) {
        const href = safeLink(value);
        if (!href) continue;
        const link = node("a", "text-button", `${label} ↗`);
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `${label === "Figma" ? "Figma-Board" : label === "Mail" ? "Mail im Hub" : label === "Slack"
          ? task.status === "clarification" ? "Klärung in Slack" : "Fehler in Slack" : label} öffnen: ${task.title || task.id}`);
        links.append(link);
      }
      const detail = node("button", "icon-button", "⋯");
      detail.setAttribute("aria-label", `Details zu ${task.title || task.id}`);
      detail.addEventListener("click", () => taskDetails(task));
      actionGroup.append(detail, links);
      if (canComplete(task)) actionGroup.append(completionButton(task));
      actions.append(actionGroup);
      row.append(titleCell, category, state, assigned, updated, actions);
      body.append(row);
    });
  }
  function detailField(label, value, wide = false) {
    const item = node("div", wide ? "wide" : "");
    item.append(
      node("span", "datum-label", label),
      node("strong", "", value ?? "Unbekannt"),
    );
    return item;
  }
  function openDetail(title, children, wide = false) {
    openTask = null;
    $("detail-title").textContent = title;
    $("detail-body").replaceChildren(...children);
    $("detail-dialog").classList.toggle("wide", wide);
    $("detail-action-error").hidden = true;
    if (!$("detail-dialog").open) $("detail-dialog").showModal();
  }
  function previewImage(id) {
    if (!previewImages.has(id)) {
      const connection = credentials;
      const request = fetch(
        `${relayPrefix}/v1/teams/${encodeURIComponent(connection.teamId)}/fleet/previews/${id}`,
        { headers: { Authorization: `Bearer ${connection.token}` } },
      )
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.blob();
        })
        .then((blob) => URL.createObjectURL(blob));
      request.catch(() => previewImages.delete(id));
      previewImages.set(id, request);
      // Bounded memory: forget the oldest downloaded pictures.
      for (const [oldId, old] of previewImages) {
        if (previewImages.size <= 40) break;
        previewImages.delete(oldId);
        old.then((url) => URL.revokeObjectURL(url), () => {});
      }
    }
    return previewImages.get(id);
  }
  function clearPreviews() {
    for (const request of previewImages.values()) request.then((url) => URL.revokeObjectURL(url), () => {});
    previewImages.clear();
  }
  // Flow mails share the task name ("TISSO Reise – Mail 01"); show what differs.
  function mailNames(previews) {
    const parts = previews.map((entry) => String(entry.title || "").split(" – "));
    const shared = parts.length > 1 && parts.every((part) => part.length > 1 && part.slice(0, -1).join(" – ") === parts[0].slice(0, -1).join(" – "));
    return parts.map((part, index) => (shared ? part.at(-1) : previews[index].title) || `Mail ${index + 1}`);
  }
  function taskSignature(task) {
    return JSON.stringify([task.status, packageHint(task), task.progress, task.step, task.phase, task.blockedReason, task.workerId, task.pmOwner, task.completion,
      (task.previews || []).map((entry) => [entry.id, entry.render])]);
  }
  function draftSection(task, keep) {
    const previews = task.previews;
    const names = mailNames(previews);
    const index = Math.max(0, previews.findIndex((entry) => entry.title === keep.mail));
    const entry = previews[index];
    const section = node("section", "draft");
    section.setAttribute("aria-labelledby", "draft-heading");
    const head = node("div", "draft-head");
    const label = node("div", "draft-label");
    const heading = node("h3", "", task.status === "completed" ? "Letzter Entwurf" : "Aktueller Entwurf");
    heading.id = "draft-heading";
    const meta = node("span", "draft-meta", `${entry.render}. Render · ${relative(entry.renderedAt)}`);
    meta.title = `Gerendert ${exact(entry.renderedAt)}`;
    label.append(heading, meta);
    head.append(label);
    const show = (next) => {
      const focusKey = document.activeElement?.dataset?.focusKey || "mail";
      openTask.mail = previews[next].title;
      section.replaceWith(draftSection(task, { mail: previews[next].title }));
      const target = $("detail-body").querySelector(`[data-focus-key="${focusKey}"]`);
      (target && !target.disabled ? target : $("detail-body").querySelector('[data-focus-key="mail"]'))?.focus();
    };
    if (previews.length > 1) {
      const nav = node("div", "draft-nav");
      const back = node("button", "icon-button", "‹");
      back.type = "button";
      back.dataset.focusKey = "back";
      back.setAttribute("aria-label", "Vorherige Mail");
      back.disabled = index === 0;
      back.addEventListener("click", () => show(index - 1));
      const select = node("select", "draft-select");
      select.dataset.focusKey = "mail";
      select.setAttribute("aria-label", `Mail auswählen, ${index + 1} von ${previews.length}`);
      names.forEach((name, position) => {
        const option = node("option", "", `${name} · ${position + 1}/${previews.length}`);
        option.value = String(position);
        option.selected = position === index;
        select.append(option);
      });
      select.addEventListener("change", () => show(Number(select.value)));
      const next = node("button", "icon-button", "›");
      next.type = "button";
      next.dataset.focusKey = "next";
      next.setAttribute("aria-label", "Nächste Mail");
      next.disabled = index === previews.length - 1;
      next.addEventListener("click", () => show(index + 1));
      nav.append(back, select, next);
      head.append(nav);
    }
    section.append(head);
    if (entry.subject) {
      const subject = node("p", "draft-subject");
      subject.append(node("span", "datum-label", "Betreff"), node("span", "", entry.subject));
      section.append(subject);
    }
    const well = node("div", "draft-well");
    well.tabIndex = 0;
    well.dataset.focusKey = "well";
    well.setAttribute("role", "region");
    well.setAttribute("aria-label", `Entwurf ${names[index]}, scrollbar`);
    const sheet = node("div", "draft-sheet");
    sheet.style.maxWidth = `${entry.width}px`;
    sheet.style.aspectRatio = `${entry.width} / ${entry.height}`;
    const state = node("span", "draft-state", "Entwurf wird geladen …");
    sheet.append(state);
    well.append(sheet);
    section.append(well);
    const load = () => {
      state.replaceChildren("Entwurf wird geladen …");
      sheet.dataset.state = "loading";
      previewImage(entry.id).then((url) => {
        const image = node("img");
        image.alt = `Entwurf: ${entry.title}`;
        image.width = entry.width;
        image.height = entry.height;
        image.src = url;
        image.decoding = "async";
        sheet.replaceChildren(image);
        sheet.dataset.state = "ready";
      }, () => {
        const retry = node("button", "button secondary", "Erneut laden");
        retry.type = "button";
        retry.addEventListener("click", load);
        state.replaceChildren(node("span", "", "Entwurf konnte nicht geladen werden."), retry);
        sheet.dataset.state = "error";
      });
    };
    load();
    if (keep.scrollTop) requestAnimationFrame(() => { well.scrollTop = keep.scrollTop; });
    return section;
  }
  // A new render or step while the dialog is open replaces it in place,
  // keeping the selected mail, scroll position and focused control.
  function refreshOpenTask() {
    if (!openTask || !$("detail-dialog").open) return;
    const task = tasks().find((entry) => entry.id === openTask.id);
    if (!task || taskSignature(task) === openTask.signature) return;
    const focusKey = document.activeElement?.dataset?.focusKey;
    taskDetails(task, { mail: openTask.mail, scrollTop: $("detail-body").querySelector(".draft-well")?.scrollTop });
    if (focusKey) $("detail-body").querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }
  function taskDetails(task, keep = {}) {
    const grid = node("div", "detail-grid");
    const salesStatuses = { reserved: "Reserviert", running: "Läuft", delivery: "PDF-Upload", blocked: "Blockiert", aborted: "Abgebrochen", done: "Fertig" };
    grid.append(
      detailField("Unternehmen", task.company || "Nicht hinterlegt"),
      detailField("Workflow", workflow(task)),
      detailField("Status", completionLabel(task)),
      detailField("Worker", workerName(task.workerId, "Noch nicht zugewiesen")),
      detailField(
        "Fortschritt",
        Number.isFinite(task.progress)
          ? percentText(task.progress)
          : "Nicht gemeldet",
      ),
      detailField(
        "Letzter Schritt",
        task.step || task.phase || "Noch kein Schritt gemeldet",
        true,
      ),
      detailField(task.workflow === "sales" ? "Sales-Status" : "ClickUp-Status",
        (task.workflow === "sales" ? salesStatuses[task.sourceStatus] : task.sourceStatus) || "Unbekannt"),
      detailField("Aktualisiert", exact(task.updatedAt)),
    );
    if (stageOf(task) === "clarification") grid.append(detailField("Wartet auf", task.pmOwner || "PM in Slack noch nicht bestätigt"));
    if (task.blockedReason) grid.append(detailField(task.status === "clarification" ? "Offene Klärung" : "Blockiergrund", task.blockedReason, true));
    const source = runningPackage(task);
    if (source) grid.append(detailField("Sprachpaket", source.title || source.id, true),
      detailField("Sprachfassung", `${packageLanguage(task).toUpperCase()} · folgt im laufenden Paket; noch nicht gestartet`, true));
    const tags = node("div", "detail-tags");
    (task.tags || []).forEach((tag) =>
      tags.append(node("span", "workflow-name", tag)),
    );
    const children = [node("p", "", task.id), grid, tags];
    const errorUrl = safeLink(task.errorUrl);
    if (errorUrl) {
      const link = node("a", "button primary", task.status === "clarification" ? "Klärung in Slack öffnen ↗" : "Fehler in Slack öffnen ↗");
      link.href = errorUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      children.push(link, node("p", "form-hint", task.status === "clarification"
        ? "Die Aufgabe wartet auf Informationen, eine Freigabe oder einen Zugang. Sobald sie fortgesetzt wird, verschwindet der Klärungsbedarf aus dieser Ansicht."
        : "Die Fehlermeldung beschreibt den aktuellen blockierten Versuch. Sobald die Aufgabe fortgesetzt oder abgeschlossen wird, zählt sie nicht mehr als blockiert."));
    }
    const url = safeLink(task.url);
    if (url) {
      const link = node("a", "button primary", task.workflow === "sales" ? "Shop öffnen ↗" : "In ClickUp öffnen ↗");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      children.push(link);
    }
    const mailUrl = safeLink(task.mailUrl);
    if (mailUrl) {
      const link = node("a", "button secondary", "Mail im Hub öffnen ↗");
      link.href = mailUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      children.push(link);
    }
    const figmaUrl = safeLink(task.figmaUrl);
    if (figmaUrl) {
      const link = node("a", "button secondary", "Figma-Board öffnen ↗");
      link.href = figmaUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      children.push(link);
    }
    if (task.status === "completed") grid.append(detailField(task.completion === "manual" ? "Manuell abgehakt" : "Abgeschlossen", exact(task.completedAt)),
      detailField("Abschlussbeleg", task.completedAt ? task.completion === "manual" ? "Manuell im Monitor bestätigt" : "Erfolgreicher Auftragsabschluss" : "Kein belegtes Abschlussdatum; zählt nicht als heute fertig", true));
    if (canComplete(task)) children.push(completionButton(task, true));
    if (!task.previews?.length) {
      openDetail(task.title || task.id, children);
    } else {
      // With a draft the dialog becomes a split inspector: facts | the mail itself.
      const facts = node("div", "inspector-facts");
      facts.append(...children);
      const inspector = node("div", "task-inspector");
      inspector.append(facts, draftSection(task, keep));
      openDetail(task.title || task.id, [inspector], true);
    }
    openTask = { id: task.id, mail: keep.mail ?? task.previews?.[0]?.title, signature: taskSignature(task) };
  }
  // Each accepted task keeps its own reported progress, including a real 0 %.
  function workingOn(machine) {
    const field = detailField("Arbeitet an", idleLabel(machine), true);
    field.classList.add("machine-work");
    field.dataset.workerId = machine.workerId || "";
    field.dataset.deviceId = machine.deviceId || "";
    const active = activeTasks(machine);
    field.dataset.signature = JSON.stringify([idleLabel(machine), active.map(task =>
      [task.id, task.title, task.workflow, task.status, task.progress, task.step, task.phase])]);
    if (!active.length) return field;
    field.querySelector("strong").remove();
    const list = node("ul", "machine-tasks");
    for (const task of active) {
      const item = node("li", "machine-task");
      item.append(taskKindBadge(task));
      const head = node("div", "machine-task-heading");
      head.append(node("strong", "machine-task-title", task.title || task.id));
      const reserved = task.status === "queued";
      const progress = displayPercent(task.progress);
      if (!reserved && progress !== null) {
        head.append(node("span", "machine-task-percent", percentText(progress)));
        const track = node("div", "usage-track");
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", `Fortschritt: ${task.title || task.id}`);
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(progress));
        const fill = node("div", "usage-fill");
        fill.style.width = `${progress}%`;
        track.append(fill);
        item.append(head, track);
      } else {
        item.append(head, node("span", "machine-task-state", reserved
          ? "Reserviert · startet gleich" : "Fortschritt noch nicht gemeldet"));
      }
      if (task.step || task.phase) item.append(node("span", "machine-task-step", task.step || task.phase));
      list.append(item);
    }
    field.append(list);
    return field;
  }
  // Update only the work list so an open Mac dialog keeps its scroll and focus.
  function refreshMachineWork(devices) {
    if (!$("detail-dialog").open) return;
    const field = $("detail-body").querySelector(".machine-work");
    if (!field) return;
    const machine = devices.find(entry => field.dataset.deviceId
      ? entry.deviceId === field.dataset.deviceId
      : field.dataset.workerId && entry.workerId === field.dataset.workerId);
    if (!machine) return;
    const next = workingOn(machine);
    if (next.dataset.signature !== field.dataset.signature) field.replaceWith(next);
  }
  function machineDetails(machine) {
    const account = machineAccount(machine);
    const accountIdentity = machineAccountIdentity(machine);
    const accountField = detailField(isCodexRepair(machine) ? "Codex-Account" : machine.claudeAccounts ? "Claude-Accounts" : "Claude-Monitoring-Account", machine.claudeAccounts ? accountIdentity.text : account ? accountIdentity.text
      : isCodexRepair(machine) ? "Codex auf diesem Worker-Mac anmelden" : "Auf diesem Worker-Mac unter Queue & Macs → Monitoring-Account verbinden", true);
    if (account && machine.claudeAccounts?.accounts?.length !== 2) {
      const name = accountField.querySelector("strong");
      name.classList.add("claude-account-name");
      markAccountAvailability(name, fleetAccountLines(machine)[0]);
    }
    const grid = node("div", "detail-grid");
    const [battery, source] = batteryText(machine);
    const batteryField = detailField("Akku", `${battery}${source ? ` · ${source}` : ""}`);
    batteryField.querySelector("strong").dataset.tone = batteryTone(machine);
    grid.append(
      batteryField,
      detailField("Direkte Worker-Meldung", machine.agentLastSeenAt
        ? `${machine.activity?.fresh ? "Live" : "Veraltet"} · ${exact(machine.agentLastSeenAt)}` : "Wird eingerichtet"),
      detailField("Wartungsdienst", machine.maintenance
        ? `${machine.maintenance.ok ? "Geprüft" : "Prüfung fehlgeschlagen"} · ${machine.maintenance.summary}` : "Noch keine Prüfung gemeldet"),
      detailField("macOS-Gerätename", machine.deviceName || (machine.name !== machine.workerId ? machine.name : null) || "Nicht gemeldet"),
      detailField("Erreichbarkeit", statusNames[machine.status] || "Unbekannt"),
      detailField("Betriebsstatus", statusNames[machineDisplayStatus(machine)] || "Unbekannt"),
      detailField(
        "Letzte Geräte-Meldung",
        exact(machine.lastSeenAt || machine.receivedAt || machine.seenAt),
      ),
      detailField(
        "Mac in Slack",
        machine.workerIdSource === "worker"
          ? `${machine.workerId} · vom Newsletter-Worker auf diesem Mac gemeldet`
          : machine.workerId || "Noch nicht mit einer Worker-ID verbunden",
        true,
      ),
      workingOn(machine),
      detailField("Plätze", machineLoad(machine)
        ? `${machine.load.occupied} von ${Number.isInteger(machine.load.max) ? machine.load.max : "?"} belegt · laut ${machine.load.source === "agent" ? "Worker" : "RS Hub"}, ${relative(machine.load.observedAt)}`
        : machine.load ? "Keine aktuelle Meldung" : "Nicht gemeldet"),
      detailField(
        "Version",
        machine.appVersion || machine.workerVersion || "Unbekannt",
      ),
      accountField,
      ...(isCodexRepair(machine) ? [detailField("Worker-Art", "Codex Repair Worker"),
        detailField("Aufgaben", "Technische Reparaturen · Kunden-Onboarding")] : []),
      detailField("Figma-Account", machineFigmaIdentity(machine).text, true),
      ...(machine.figmaAccount ? [detailField(machine.figmaAccount.source === "mcp-whoami" ? "Figma-Account geprüft" : "Figma zuletzt verwendet", exact(machine.figmaAccount.observedAt))] : []),
      ...(accountIdentity.email ? [detailField(`${machineProviderLabel(machine)}-E-Mail`, accountIdentity.email, true)] : []),
      detailField("Kontingente geprüft", exact(machine.usageUpdatedAt)),
      detailField(
        "Always On",
        machine.nativeStatus && machine.nativeStatus !== "online"
          ? "App-Daten veraltet"
          : machine.stayAwakeEnabled == null
          ? "Nicht gemeldet"
          : machine.stayAwakeEnabled
            ? "Aktiv"
            : "Aus",
      ),
    );
    const blocked = blockedCorrections(machine);
    if (blocked.length) {
      const field = detailField("Blockierte Korrekturen", blockedCorrectionLabel(blocked), true);
      for (const task of blocked) {
        const link = node("button", "text-button detail-line", `${task.title || task.id} ↗`);
        link.type = "button";
        link.addEventListener("click", () => taskDetails(task));
        field.append(link, node("p", "form-hint", task.blockedReason || task.phase || "Grund noch nicht gemeldet"));
      }
      grid.append(field);
    }
    if (machine.nativeLastSeenAt)
      grid.append(
        detailField("App-Meldungen", machine.nativeStatus === "online" ? "Aktuell" : "Keine aktuelle Meldung"),
        detailField("Letzte App-Meldung", exact(machine.nativeLastSeenAt)),
      );
    if (Number.isInteger(machine.pendingClickup))
      grid.append(
        detailField("ClickUp-Abgleich", machine.pendingClickup > 0
          ? `${machine.pendingClickup} ${machine.pendingClickup === 1 ? "Änderung wird" : "Änderungen werden"} automatisch erneut übertragen`
          : "Alle Änderungen übertragen"),
      );
    if (machine.workerLastSeenAt)
      grid.append(
        detailField("Worker-Erreichbarkeit", statusNames[machine.workerStatus] || "Unbekannt"),
        detailField(
          `${machineWorkerLabel(machine)} gemeldet`,
          exact(machine.workerLastSeenAt),
        ),
      );
    const list = node("div");
    if (machine.nativeStatus && machine.nativeStatus !== "online" && machine.status === "online")
      list.append(node("p", "form-hint", `${machineWorkerLabel(machine)} bestätigt, dass dieser Mac erreichbar ist. Akku-Messungen stammen separat aus der Mac-App.`));
    for (const issue of machine.workerIssues || []) {
      list.append(node("p", "usage-note fleet-issue", `${issue.stage}: ${issue.message}`));
      list.append(node("p", "form-hint", `Fehler gemeldet: ${exact(issue.reportedAt)}`));
    }
    if ((machine.workerIssues || []).some(issue => issue.stage === "claude"))
      list.append(node("p", "form-hint", "Claude auf diesem Mac prüfen und bei einem Anmeldefehler erneut anmelden. Die Warnung verschwindet nach dem nächsten vollständigen Abgleich, sobald der Worker seine Meldung entfernt hat."));
    (machine.limits || []).forEach((limit) => {
      const outdated = limitStale(limit, usageStale(machine) || Boolean(machine.usageError));
      const line = node("div", "usage-line");
      line.append(
        node(
          "span",
          "",
          `${claudeAccountIdentity((machine.accounts || []).find(a => a.accountId === limit.accountId) || {name:limit.accountName}).name} · ${limit.label || limit.kind}`,
        ),
        node("strong", "", limit.percent == null ? "—" : `${percentText(limit.percent)} genutzt`),
      );
      line.querySelector("strong").dataset.tone = percentTone(limit.percent, outdated);
      line.title = limitTitle(limit, outdated);
      list.append(line);
      list.append(
        node(
          "p",
          outdated
            ? "usage-note"
            : "form-hint",
          `${limit.usageError || machine.usageError || (outdated ? "Veraltete Messung" : "Geprüft")} · ${exact(limit.usageUpdatedAt || machine.usageUpdatedAt)}`,
        ),
      );
      if (limit.resetsAt)
        list.append(limitReset(limit, outdated));
    });
    for (const account of machine.accounts || []) {
      if (
        !(machine.limits || []).some(
          (limit) => limit.accountId === account.accountId,
        )
      )
        list.append(
          node(
            "p",
            "usage-note",
            `${claudeAccountIdentity(account).name}: ${account.usageError || "Noch keine Kontingente gemeldet"}`,
          ),
        );
    }
    const children = [accountActions(machine),...(machine.claudeAccounts?.accounts?.length===2 ? [workerAccountsGrid(machine)] : []), grid, list];
    if (machine.workerId) {
      const button = node(
        "button",
        "button secondary",
        "Aufgaben dieses Macs anzeigen",
      );
      button.addEventListener("click", () => {
        workerFilter = machine.workerId;
        statusFilter = "all";
        $("detail-dialog").close();
        selectView("queue");
      });
      children.push(button);
    }
    if (snapshot?.capabilities?.canDeleteMachines && machine.memberId && machine.memberId !== "team-owner") {
      const remove = node("button", "button danger", "Mac endgültig löschen…");
      remove.addEventListener("click", () => confirmMachineDeletion(machine));
      children.push(remove);
    }
    openDetail(workerName(machine.workerId, machine.name), children);
  }
  function confirmMachineDeletion(machine) {
    const label = workerName(machine.workerId, machine.name);
    const message = node("p", "", `„${label}“ und der zugehörige Mitgliedszugang werden endgültig gelöscht. Alle Macs dieses Mitglieds sowie ihre Kontingentdaten und Verläufe werden entfernt. Automatische Worker-Meldungen stellen sie nicht wieder her. Das kann nicht rückgängig gemacht werden.`);
    const actions = node("div", "dialog-actions");
    const cancel = node("button", "button secondary", "Abbrechen");
    const remove = node("button", "button danger", "Endgültig löschen");
    cancel.addEventListener("click", () => machineDetails(machine));
    remove.addEventListener("click", () => deleteMachine(machine, remove, cancel));
    actions.append(cancel, remove);
    openDetail("Mac endgültig löschen?", [message, actions]);
    cancel.focus();
  }
  async function deleteMachine(machine, button, cancel) {
    if (!credentials || !snapshot?.capabilities?.canDeleteMachines) return;
    const connection = credentials;
    button.disabled = true;
    cancel.disabled = true;
    button.textContent = "Wird gelöscht…";
    button.setAttribute("aria-busy", "true");
    $("detail-action-error").hidden = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${relayPrefix}/v1/teams/${encodeURIComponent(connection.teamId)}/members/${encodeURIComponent(machine.memberId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${connection.token}` },
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Löschen fehlgeschlagen. Versuche es erneut.");
      if (connection !== credentials) return;
      stopLive();
      generation += 1;
      fetchController?.abort();
      busy = false;
      const removed = snapshot.machines.filter((entry) => entry.memberId === machine.memberId);
      const devices = new Set(removed.map((entry) => entry.deviceId));
      const workers = new Set(removed.map((entry) => entry.workerId).filter(Boolean));
      snapshot.machines = snapshot.machines.filter((entry) => entry.memberId !== machine.memberId);
      snapshot.events = snapshot.events.filter((entry) => entry.type.startsWith("machine_")
        ? !devices.has(entry.deviceId || entry.entityId)
        : entry.type.startsWith("worker_") ? !workers.has(entry.workerId || entry.entityId) : true);
      $("detail-dialog").close();
      render();
      $("main").focus({ preventScroll: true });
      await refresh();
      startLive();
    } catch (error) {
      if (connection !== credentials) return;
      $("detail-action-error").textContent = error.name === "AbortError"
        ? "Löschen konnte nicht bestätigt werden. Aktualisiere die Ansicht und prüfe, ob der Mac noch vorhanden ist."
        : error.message;
      $("detail-action-error").hidden = false;
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      cancel.disabled = false;
      button.textContent = "Endgültig löschen";
      button.setAttribute("aria-busy", "false");
    }
  }
  function logRows(attention) {
    if (logFilter === "attention") {
      return attention.map((entry) => {
        const entity = entry.entity;
        const task = entry.type === "task";
        return {
          type: task ? "task" : "machine",
          title: task ? entity.title || entity.id : workerName(entity.workerId, entity.name),
          id: task ? entity.id : entity.workerId || entity.deviceId,
          kind: task ? workflow(entity) : "Mac",
          workerId: entity.workerId,
          at: task ? entity.updatedAt : entity.receivedAt || entity.lastSeenAt,
          status: task ? entity.status : machineDisplayStatus(entity),
          statusLabel: statusNames[task ? entity.status : machineDisplayStatus(entity)] || "Unbekannt",
          messages: entry.reasons,
          phase: task ? entity.phase : null,
          entity,
          attention: true,
        };
      });
    }
    const taskMap = new Map(tasks().map((task) => [task.id, task]));
    const devices = machines();
    return (Array.isArray(snapshot?.events) ? snapshot.events : []).map((event) => {
      const type = event.type?.startsWith("task_") ? "task"
        : event.type?.startsWith("machine_") || event.type?.startsWith("worker_")
          ? "machine" : "source";
      const entity = type === "task" ? taskMap.get(event.taskId || event.entityId)
        : type === "machine" ? devices.find((machine) =>
          event.deviceId ? machine.deviceId === event.deviceId
            : machine.workerId === (event.workerId || event.entityId)) : null;
      const status = String(event.type || "").replace(/^(task|machine|worker)_/, "");
      const special = {
        registered: ["online", "Verbunden"],
        error: ["failed", "Fehler"],
        warning: ["blocked", "Warnung"],
        recovered: ["online", "Warnung entfernt"],
        removed: ["unknown", "Entfernt"],
        queue_source_error: ["failed", "Gestört"],
        queue_source_recovered: ["online", "Erreichbar"],
      }[status];
      const capturedWorker = "workerId" in event;
      const workerId = capturedWorker ? event.workerId : entity?.workerId;
      const rawMessage = event.message || "Status aktualisiert";
      const message = /^(pre-gen|pregen|newsletter|upload): (queued|running|blocked|failed|completed)$/.test(rawMessage)
        ? "Aufgabenstatus aktualisiert" : rawMessage;
      return {
        type,
        title: type === "machine" ? workerName(workerId, event.title || entity?.name || "Mac")
          : event.title || entity?.title || (type === "source" ? "Queue-Quelle" : "Status aktualisiert"),
        id: type === "task" ? event.taskId || event.entityId : type === "machine" ? event.workerId || entity?.workerId : "",
        kind: type === "task" ? workflow(event.workflow || entity?.workflow || "Aufgabe")
          : type === "machine" ? "Mac" : "Queue-Quelle",
        workerId,
        currentWorker: !capturedWorker && Boolean(workerId),
        at: event.at || event.receivedAt || event.timestamp,
        status: special?.[0] || (statusNames[status] ? status : "unknown"),
        statusLabel: special?.[1] || statusNames[status] || "Info",
        messages: [message],
        event,
        entity,
      };
    });
  }
  function logDetails(row) {
    const grid = node("div", "detail-grid");
    grid.append(
      detailField(row.attention ? "Aktualisiert" : "Ereigniszeitpunkt", exact(row.at)),
      detailField("Typ", row.kind),
      detailField("Status", row.statusLabel),
      detailField(row.currentWorker ? "Mac · aktuelle Zuordnung" : "Mac", workerName(row.workerId, "Nicht zugeordnet")),
    );
    const reasons = node("ul", row.attention ? "attention-reasons" : "log-detail-messages");
    row.messages.forEach((message) => reasons.append(node("li", "", message)));
    const children = [grid, reasons];
    if (row.id) children.push(node("p", "form-hint", row.id));
    if (row.phase) children.push(node("p", "form-hint", `Letzter Schritt: ${row.phase}`));
    if (row.entity) {
      const button = node("button", "button secondary", row.type === "task"
        ? "Aktuelle Aufgabe öffnen" : "Mac-Details öffnen");
      button.addEventListener("click", () => row.type === "task"
        ? taskDetails(row.entity) : machineDetails(row.entity));
      children.push(button);
    }
    if (row.type === "task" && ["blocked", "failed"].includes(row.status) && canComplete(row.entity)) {
      children.push(completionButton(row.entity, true));
    }
    openDetail(row.title, children);
  }
  function renderEvents(attention) {
    const body = $("log-body");
    if (!body) return;
    const allRows = logRows(attention);
    if (logFilter === "attention" && logType === "source") {
      logType = "all";
      logPage = 0;
      saveFilters();
    }
    $("log-source-option").disabled = logFilter === "attention";
    $("log-search").value = logQuery;
    $("log-type").value = logType;
    const queryText = logQuery.trim().toLocaleLowerCase("de-DE");
    const visible = allRows.filter((row) =>
      (logType === "all" || row.type === logType) && (!queryText ||
        [row.title, row.id, row.kind, row.workerId, workerName(row.workerId, ""), row.entity?.deviceName, row.statusLabel, row.phase, ...row.messages]
          .filter(Boolean).join(" ").toLocaleLowerCase("de-DE").includes(queryText)))
      .sort((a, b) => {
        const first = timestamp(a.at);
        const second = timestamp(b.at);
        if (first === null || second === null) return (first === null) - (second === null);
        return logOldestFirst ? first - second : second - first;
      });
    const page = Math.min(logPage, Math.max(0, Math.ceil(visible.length / pageSize) - 1));
    if (page !== logPage) { logPage = page; saveFilters(); }
    body.replaceChildren();
    const direction = logOldestFirst ? "↑" : "↓";
    $("log-time-heading").setAttribute("aria-sort", logOldestFirst ? "ascending" : "descending");
    $("log-time-sort").textContent = `Zeitpunkt ${direction}`;
    $("log-sort").textContent = `${logOldestFirst ? "Älteste" : "Neueste"} zuerst ${direction}`;
    $("log-caption").textContent = `Queue-Log: ${logFilter === "attention" ? "Braucht Aufmerksamkeit" : "Alle Ereignisse"}`;
    $("log-message-heading").textContent = logFilter === "attention" ? "Grund" : "Ereignis";
    $("log-count").textContent = numberFormat.format(visible.length);
    $("log-event-count").textContent = numberFormat.format(Array.isArray(snapshot?.events) ? snapshot.events.length : 0);
    $("log-summary").textContent = !snapshot ? "Noch keine Daten geladen."
      : logFilter === "attention" ? `${numberFormat.format(attention.filter((entry) => entry.type === "machine").length)} Macs · ${numberFormat.format(attention.filter((entry) => entry.type === "task").length)} Aufgaben brauchen Aufmerksamkeit. Jeder Eintrag zählt einmal.`
        : "";
    $("log-summary").hidden = !$("log-summary").textContent;
    for (const row of visible.slice(logPage * pageSize, (logPage + 1) * pageSize)) {
      const line = node("tr", row.attention ? "log-row attention-entry" : "log-row");
      line.dataset.logType = row.type;
      if (row.attention) line.dataset.attentionType = row.type;
      const cell = (name, label) => {
        const result = node("td", `log-${name}`);
        result.dataset.label = label;
        return result;
      };
      const when = cell("time", "Zeitpunkt");
      const time = node("time", "", exact(row.at));
      if (timestamp(row.at) !== null) time.dateTime = new Date(timestamp(row.at)).toISOString();
      time.title = exact(row.at);
      when.append(time, node("small", "log-secondary", relative(row.at)));
      const subject = cell("entity", "Aufgabe / Bezug");
      const title = node("strong", "log-title", row.title);
      title.title = row.title;
      const meta = node("div", "log-entity-meta");
      meta.append(node("span", "workflow", row.kind));
      if (row.type === "task" && row.id) {
        const id = node("small", "log-id", row.id);
        id.title = row.id;
        meta.append(id);
      }
      subject.append(title, meta);
      const worker = cell("worker", "Mac");
      const workerLabel = node("span", "log-worker-name", workerName(row.workerId, row.type === "source" ? "—" : "Nicht zugeordnet"));
      workerLabel.title = row.workerId || "";
      worker.append(workerLabel);
      if (row.currentWorker) worker.append(node("small", "log-secondary", "aktuelle Zuordnung"));
      const state = cell("status", "Status");
      const signal = badge(row.status);
      signal.lastChild.textContent = row.statusLabel;
      state.append(signal);
      const message = cell("message", row.attention ? "Grund" : "Ereignis");
      const messages = node("ul", row.attention ? "attention-reasons" : "log-messages");
      row.messages.slice(0, 2).forEach((text) => {
        const item = node("li", "", text);
        item.title = text;
        messages.append(item);
      });
      if (row.messages.length > 2) messages.append(node("li", "log-secondary", `+ ${row.messages.length - 2} weitere Gründe`));
      message.append(messages);
      if (row.phase) {
        const phase = node("small", "log-secondary", `Letzter Schritt: ${row.phase}`);
        phase.title = row.phase;
        message.append(phase);
      }
      const action = cell("action", "Aktionen");
      const button = node("button", "icon-button", "↗");
      button.setAttribute("aria-label", `Details zu ${row.title}`);
      button.addEventListener("click", () => logDetails(row));
      action.append(button);
      if (row.type === "task" && ["blocked", "failed"].includes(row.status) && canComplete(row.entity)) {
        action.append(completionButton(row.entity));
      }
      line.append(when, subject, worker, state, message, action);
      body.append(line);
    }
    $("event-list").hidden = visible.length === 0;
    $("log-empty").hidden = visible.length !== 0;
    $("log-empty").textContent = !snapshot ? "Verbinde den Team-Server, um das Queue-Log zu sehen."
      : allRows.length && !visible.length ? "Keine passenden Einträge. Passe die Suche oder den Typ-Filter an."
        : logFilter === "attention" ? "Aktuell braucht kein Mac und keine Aufgabe Aufmerksamkeit."
          : "Noch keine Ereignisse. Neue Aufgaben und Mac-Meldungen erscheinen hier.";
    const first = visible.length ? logPage * pageSize + 1 : 0;
    const last = Math.min((logPage + 1) * pageSize, visible.length);
    $("log-results").textContent = `${numberFormat.format(first)}–${numberFormat.format(last)} von ${numberFormat.format(visible.length)} Einträgen${visible.length !== allRows.length ? ` · ${numberFormat.format(allRows.length)} insgesamt` : ""}`;
    $("log-pagination").hidden = visible.length <= pageSize;
    $("log-page-label").textContent = `Seite ${logPage + 1} / ${Math.max(1, Math.ceil(visible.length / pageSize))}`;
    $("log-previous").disabled = logPage === 0;
    $("log-next").disabled = (logPage + 1) * pageSize >= visible.length;
  }
  let previousNativeView='overview';
  window.addEventListener('max-monitor-view',event=>{
    if(event.detail==='usage') {if(view!=='usage')previousNativeView=view;selectView('usage');}
    else if(event.detail==='queue' && view==='usage')selectView(previousNativeView);
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        if (button.classList.contains("nav-item") && button.dataset.status) {
          openQueue(button.dataset.status);
          return;
        }
        selectView(
          button.dataset.view,
          button.dataset.status,
          button.dataset.logFilter,
        );
      }),
    );
  document.querySelectorAll("#status-tabs .tab").forEach((button) =>
    button.addEventListener("click", () => {
      statusFilter = button.dataset.status;
      queuePage = 0;
      saveFilters();
      render();
    }),
  );
  document.querySelectorAll("[data-pipeline-period]").forEach((button) =>
    button.addEventListener("click", () => {
      pipelinePeriod = button.dataset.pipelinePeriod;
      saveFilters();
      render({ preserveScroll: true });
    }),
  );
  $("clear-queue-period").addEventListener("click", () => {
    queuePeriod = "all";
    queuePage = 0;
    saveFilters();
    render({ preserveScroll: true });
  });
  document.querySelectorAll("#log-filters .tab").forEach((button) =>
    button.addEventListener("click", () => {
      logFilter = button.dataset.logFilter;
      logPage = 0;
      saveFilters();
      render();
    }),
  );
  $("search").value = query;
  $("search").addEventListener("input", () => {
    query = $("search").value;
    queuePage = 0;
    saveFilters();
    renderQueue(tasks());
  });
  $("workflow").addEventListener("change", () => {
    workflowFilter = $("workflow").value;
    queuePage = 0;
    saveFilters();
    renderQueue(tasks());
  });
  $("page-previous").addEventListener("click", () => {
    queuePage--;
    renderQueue(tasks());
  });
  $("page-next").addEventListener("click", () => {
    queuePage++;
    renderQueue(tasks());
  });
  $("clear-worker").addEventListener("click", () => {
    workerFilter = "";
    saveFilters();
    render();
  });
  if ($("log-search")) {
    $("log-search").addEventListener("input", () => {
      logQuery = $("log-search").value;
      logPage = 0;
      saveFilters();
      renderEvents(attentionEntries(machines(), tasks()));
    });
    $("log-type").addEventListener("change", () => {
      logType = $("log-type").value;
      logPage = 0;
      saveFilters();
      renderEvents(attentionEntries(machines(), tasks()));
    });
    for (const id of ["log-sort", "log-time-sort"]) $(id).addEventListener("click", () => {
      logOldestFirst = !logOldestFirst;
      logPage = 0;
      saveFilters();
      renderEvents(attentionEntries(machines(), tasks()));
    });
    for (const [id, step] of [["log-previous", -1], ["log-next", 1]]) $(id).addEventListener("click", () => {
      logPage += step;
      saveFilters();
      renderEvents(attentionEntries(machines(), tasks()));
      $("log-heading").focus({ preventScroll: true });
      $("log-section").scrollIntoView({ block: "start" });
    });
  }
  $("refresh").addEventListener("click", refresh);
  $("connection-top").addEventListener("click", () => {
    $("team-id").value = credentials?.teamId || "";
    $("team-token").value = "";
    $("disconnect").hidden = !credentials;
    $("connection-dialog").showModal();
  });
  document
    .querySelectorAll("[data-close]")
    .forEach((button) =>
      button.addEventListener("click", () => button.closest("dialog").close()),
    );
  $("detail-dialog").addEventListener("close", () => { openTask = null; });
  $("skill-version-compare").addEventListener("click", skillDetails);
  $("connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    window.MaxMonitorConsumption?.reset();
    stopLive();
    fetchController?.abort();
    generation++;
    busy = false;
    credentials = {
      teamId: $("team-id").value.trim().toUpperCase(),
      token: $("team-token").value.trim(),
    };
    snapshot = null;
    clearPreviews();
    const success = await refresh();
    $("team-token").value = "";
    if (success) {
      startLive();
      $("connection-dialog").close();
      $("disconnect").hidden = false;
    }
  });
  $("disconnect").addEventListener("click", () => {
    window.MaxMonitorConsumption?.reset();
    stopLive();
    generation++;
    fetchController?.abort();
    fetchController = null;
    busy = false;
    credentials = null;
    snapshot = null;
    clearPreviews();
    $("detail-dialog").close();
    $("team-token").value = "";
    $("disconnect").hidden = true;
    $("refresh").disabled = false;
    $("connect").disabled = false;
    setSync("Nicht verbunden", "idle");
    showNotice("");
    $("machine-grid").replaceChildren(
      node(
        "div",
        "empty-state",
        "Verbinde deinen Team-Server, um alle Macs zu sehen.",
      ),
    );
    overviewMessage("Verbinde deinen Team-Server, um Queue und Macs zu sehen.");
    render();
  });
  render();
  if (credentials) { refresh(); startLive(); }
  else {
    overviewMessage("Verbinde deinen Team-Server, um Queue und Macs zu sehen.");
    $("connection-dialog").showModal();
  }
  setInterval(() => {
    if (!document.hidden) {
      if (snapshot && renderedDay !== productionDay(Date.now())) render({ preserveScroll: true });
      syncStatus();
      refresh();
    }
  }, 30000);
  watchLiveEvents();
})();
