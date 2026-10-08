"use strict";

// Credentials deliberately live only in this closure. The native host injects
// its bootstrap before this script runs; browsers use the connection dialog.
(() => {
  const $ = (id) => document.getElementById(id);
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
  const params = new URLSearchParams(location.search);
  let view = params.get("view") || "overview";
  let logFilter = params.get("log") === "attention" ? "attention" : "all";
  if (view === "attention") {
    view = "log";
    logFilter = "attention";
  }
  let statusFilter = params.get("status") || "running";
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
    silent: "Still",
    offline: "Offline",
    unknown: "Unbekannt",
    queued: "Wartet",
    running: "Läuft",
    blocked: "Blockiert",
    completed: "Fertig",
    failed: "Fehler",
  };
  const workflowNames = {
    "pre-gen": "Pre-Gen",
    pregen: "Pre-Gen",
    newsletter: "Pre-Gen",
    upload: "Upload",
  };
  // Pipeline stages mirror the ClickUp tags: the trigger tag alone means
  // "markiert"; a state tag or a worker reservation moves a task to "wartet".
  const stages = [
    ["marked", "Markiert", "queued"],
    ["queued", "Wartet", "queued"],
    ["running", "Läuft", "running"],
    ["blocked", "Blockiert", "blocked"],
    ["completed", "Fertig", "completed"],
    ["failed", "Fehler", "failed"],
  ];
  const timeFormat = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const clockFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
  const numberFormat = new Intl.NumberFormat("de-DE");
  function setSync(text, state) {
    $("sync-status").textContent = text;
    $("sync-status").dataset.state = state;
  }
  function stageOf(task) {
    if (task.status !== "queued") return task.status;
    const waiting = task.workerId || (task.tags || []).some((tag) =>
      String(tag).toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]/gu, "").endsWith("wartet"));
    return waiting ? "queued" : "marked";
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
    return workflowNames[value] || value || "Workflow";
  }
  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }
  function tasks() {
    return Array.isArray(snapshot?.queue?.tasks) ? snapshot.queue.tasks : [];
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
      return {
        ...machine,
        status: age > 1800 ? "offline" : age > 900 ? "silent" : machine.status,
      };
    });
  }
  function isOpen(task) {
    return !["completed"].includes(task.status);
  }
  function usageStale(machine) {
    return (
      machine.usageStale === true ||
      machine.status !== "online" ||
      !timestamp(machine.usageUpdatedAt) ||
      Date.now() - timestamp(machine.usageUpdatedAt) > 15 * 60000
    );
  }
  function machineAttentionReasons(machine) {
    const reasons = [];
    const limits = machine.limits || [];
    if (machine.status !== "online") {
      const source = machine.telemetrySource === "worker" ? "Worker" : "Mac";
      reasons.push(
        machine.status === "offline"
          ? `Seit über 30 Minuten keine ${source}-Meldung`
          : machine.status === "silent"
            ? `Seit über 15 Minuten keine ${source}-Meldung`
            : `${source}-Erreichbarkeit unbekannt`,
      );
    }
    if (machine.usageError || machine.usageStatus === "error")
      reasons.push("Claude-Kontingente konnten nicht geprüft werden");
    if (!limits.length) reasons.push(machine.monitoringAccountId
      ? "Claude-Kontingente noch nicht gemeldet" : "Monitoring-Account auf diesem Worker-Mac verbinden");
    else if (
      machine.usageStale ||
      !timestamp(machine.usageUpdatedAt) ||
      Date.now() - timestamp(machine.usageUpdatedAt) > 15 * 60000
    )
      reasons.push("Claude-Kontingente veraltet");
    for (const limit of limits.filter((item) => item.percent >= 100)) {
      const label = [
        limit.accountName || limit.accountId,
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
          ? `Letzter gemeldeter Claude-Wert: 100 %${label ? ` · ${label}` : ""}`
          : `Claude-Limit erreicht${label ? `: ${label}` : ""}`,
      );
    }
    if (
      machine.batteryPercent != null &&
      machine.batteryPercent <= 15 &&
      machine.powerSource !== "ac"
    )
      reasons.push(`Akku niedrig: ${machine.batteryPercent} %`);
    return reasons;
  }
  function attentionEntries(devices, items) {
    const entries = items
      .filter((task) => ["blocked", "failed"].includes(task.status))
      .map((task) => ({
        type: "task",
        entity: task,
        reasons: [
          task.status === "blocked"
            ? "Aufgabe blockiert"
            : "Aufgabe fehlgeschlagen",
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
    if (view !== "overview") state.set("view", view);
    if (logFilter !== "all") state.set("log", logFilter);
    if (statusFilter !== "running") state.set("status", statusFilter);
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
    view = ["overview", "queue", "machines", "log"].includes(next)
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
  }
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
    $("pipeline").replaceChildren(skeleton("flow", 4));
    $("attention-list").replaceChildren(skeleton("attention-calm", 3, "li"));
    $("fleet-body").replaceChildren(...Array.from({ length: 4 }, () => {
      const row = node("tr");
      const cell = node("td");
      cell.colSpan = 6;
      cell.append(node("div", "loading-line"));
      row.append(cell);
      return row;
    }));
  }
  function overviewMessage(message) {
    $("pipeline").replaceChildren(node("div", "empty-state", message));
    $("attention-list").replaceChildren();
    const row = node("tr");
    const cell = node("td", "empty-state", message);
    cell.colSpan = 6;
    row.append(cell);
    $("fleet-body").replaceChildren(row);
  }
  function syncStatus() {
    if (!snapshot || busy || !$('connection-error').hidden) return;
    setSync(`${streamConnected ? 'Live' : 'Abgleich'} · ${clockFormat.format(new Date(snapshotReceivedAt))}`, streamConnected ? 'live' : 'polling');
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
      render();
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
      if (snapshot) render();
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
  function render() {
    const items = tasks();
    const devices = machines();
    const attention = attentionEntries(devices, items);
    const openCount = items.filter(isOpen).length;
    $("nav-queue").textContent = snapshot ? numberFormat.format(openCount) : "—";
    $("nav-machines").textContent = snapshot ? numberFormat.format(devices.length) : "—";
    $("nav-attention").textContent = numberFormat.format(attention.length);
    $("nav-attention").hidden = !snapshot || !attention.length;
    $("log-attention-count").textContent = snapshot ? attention.length : "—";
    $("machine-count").textContent = devices.length;
    $("queue-count").textContent = items.length;
    const statusCounts = {
      open: openCount,
      running: items.filter((task) => task.status === "running").length,
      queued: items.filter((task) => task.status === "queued").length,
      blocked: items.filter((task) => task.status === "blocked").length,
      completed: items.filter((task) => task.status === "completed").length,
      all: items.length,
    };
    for (const [status, count] of Object.entries(statusCounts)) {
      const label = $(`${status}-count`);
      if (label) label.textContent = numberFormat.format(count);
    }
    $("page-title").textContent =
      { overview: "Übersicht", queue: "Queue", machines: "Macs", log: "Log" }[view] || "Übersicht";
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("selected", button.dataset.view === view);
      button.setAttribute(
        "aria-current",
        button.dataset.view === view ? "page" : "false",
      );
    });
    $("overview-section").hidden = view !== "overview";
    $("machines-section").hidden = view !== "machines";
    $("queue-section").hidden = view !== "queue";
    $("log-section").hidden = view !== "log";
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
    $("worker-filter-label").textContent = `Aufgaben für ${workerFilter}`;
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
      ...new Set(items.map((x) => x.workflow).filter(Boolean)),
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
      renderOverview(devices, items, attention);
    }
    renderQueue(items);
    renderEvents(attention);
  }
  function openQueue(status, workflowValue = "") {
    workerFilter = "";
    workflowFilter = workflowValue;
    query = "";
    $("search").value = "";
    selectView("queue", status);
    $("queue-heading").focus({ preventScroll: true });
  }
  function renderPipeline(items) {
    const groups = new Map();
    for (const task of items) {
      const name = workflow(task.workflow);
      if (!groups.has(name)) groups.set(name, { value: task.workflow || "", tasks: [] });
      groups.get(name).tasks.push(task);
    }
    const order = (name) => (name === "Pre-Gen" ? 0 : name === "Upload" ? 1 : 2);
    const flows = [...groups.entries()].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));
    const open = items.filter(isOpen).length;
    const done = items.length - open;
    $("pipeline-summary").textContent = snapshot
      ? `${numberFormat.format(open)} offen · ${numberFormat.format(done)} fertig`
      : "—";
    if (!flows.length) {
      $("pipeline").replaceChildren(node("div", "empty-state", snapshot?.queue?.source?.lastSuccessAt
        ? "Die Queue ist leer. Neue markierte Aufgaben erscheinen hier."
        : "Queue-Quelle noch nicht verbunden."));
      return;
    }
    $("pipeline").replaceChildren(...flows.map(([name, group]) => {
      const counts = new Map(stages.map(([key]) => [key, 0]));
      for (const task of group.tasks) counts.set(stageOf(task), (counts.get(stageOf(task)) || 0) + 1);
      const shown = stages.filter(([key]) => key !== "failed" || counts.get("failed") > 0);
      const max = Math.max(1, ...shown.map(([key]) => counts.get(key)));
      const flow = node("div", "flow");
      const head = node("div", "flow-head");
      const openInFlow = group.tasks.filter(isOpen).length;
      head.append(node("h3", "", name), node("span", "", `${numberFormat.format(openInFlow)} offen`));
      const bars = node("div", "bars");
      const labels = node("div", "bar-labels");
      labels.setAttribute("aria-hidden", "true");
      for (const [key, label, status] of shown) {
        const count = counts.get(key);
        const column = node("button", count ? "bar-col" : "bar-col zero");
        column.type = "button";
        column.dataset.stage = key;
        column.setAttribute("aria-label", `${name} · ${label}: ${numberFormat.format(count)} Aufgaben anzeigen`);
        const tip = node("span", "bar-tip", `${name} · ${label}: ${numberFormat.format(count)}`);
        tip.setAttribute("aria-hidden", "true");
        const value = node("span", "bar-value", numberFormat.format(count));
        value.setAttribute("aria-hidden", "true");
        value.append(tip);
        const bar = node("span", "bar");
        bar.style.height = `${(count / max) * 78}%`;
        column.append(value, bar);
        column.addEventListener("click", () => openQueue(status, group.value));
        bars.append(column);
        labels.append(node("span", "", label));
      }
      flow.append(head, bars, labels);
      return flow;
    }));
  }
  function attentionSeverity(entry) {
    const status = entry.entity.status;
    if (status === "offline" || status === "failed") return 0;
    if (status === "blocked") return 1;
    if (entry.reasons.some((reason) => reason.startsWith("Claude-Limit erreicht"))) return 1;
    if (status === "silent") return 2;
    return 3;
  }
  function renderAttention(attention) {
    const list = $("attention-list");
    $("attention-count").textContent = numberFormat.format(attention.length);
    $("attention-more").hidden = !attention.length;
    if (!attention.length) {
      const calm = node("li", "attention-calm");
      calm.append(node("span", "dot good"), node("span", "", "Alles in Ordnung – kein Mac und keine Aufgabe braucht dich."));
      list.replaceChildren(calm);
      return;
    }
    const limit = window.innerHeight >= 860 && window.innerWidth >= 1100 ? 6 : 4;
    const sorted = attention.slice().sort((a, b) => attentionSeverity(a) - attentionSeverity(b));
    list.replaceChildren(...sorted.slice(0, limit).map((entry) => {
      const task = entry.type === "task";
      const entity = entry.entity;
      const item = node("li");
      const button = node("button", "attention-item");
      button.type = "button";
      const severity = attentionSeverity(entry);
      const dot = node("span", `dot ${task ? entity.status : severity <= 1 ? "offline" : severity === 2 ? "silent" : "unknown"}`);
      const title = task ? entity.title || entity.id : entity.name || entity.workerId || "Mac";
      const label = node("strong", "", title);
      label.title = title;
      const reason = entry.reasons.length > 1
        ? `${entry.reasons[0]} · +${entry.reasons.length - 1}`
        : entry.reasons[0];
      const detail = node("small", "", reason);
      detail.title = entry.reasons.join(" · ");
      button.append(dot, label, node("span", "kind", task ? workflow(entity.workflow) : "Mac"), detail);
      button.setAttribute("aria-label", `${title}: ${entry.reasons.join(", ")}`);
      button.addEventListener("click", () => (task ? taskDetails(entity) : machineDetails(entity)));
      item.append(button);
      return item;
    }));
    $("attention-more").textContent = attention.length > limit
      ? `Alle ${numberFormat.format(attention.length)} im Log ansehen →`
      : "Im Log ansehen →";
  }
  function machineAccount(machine) {
    return (machine.accounts || []).find((item) => item.accountId === machine.monitoringAccountId);
  }
  function machineLimit(machine, account, kind) {
    if (!account || !Array.isArray(machine.limits)) return null;
    return machine.limits.find((item) => item.accountId === account.accountId && item.kind === kind) || null;
  }
  function runningTasks(machine) {
    return machine.workerId
      ? tasks().filter((task) => task.workerId === machine.workerId && task.status === "running")
      : [];
  }
  function batteryText(machine) {
    if (machine.batteryPercent == null) return ["—", ""];
    const source = machine.isCharging ? "lädt"
      : ["ac", "AC", "AC Power", "mains"].includes(machine.powerSource) ? "Netzteil"
        : machine.powerSource === "battery" ? "Akku" : "";
    return [`${machine.batteryPercent} %`, source];
  }
  function meter(limit, stale) {
    const value = limit?.percent ?? null;
    const wrap = node("div", `meter${value == null ? " unknown" : ""}${stale && value != null ? " stale" : ""}`);
    const track = node("div", "usage-track");
    const fill = node("div", `usage-fill ${value >= 100 ? "full" : value >= 80 ? "high" : ""}`);
    fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
    track.append(fill);
    wrap.append(track, node("b", "", value == null ? "—" : `${value} %`));
    return wrap;
  }
  function sortedMachines(devices) {
    return devices.slice().sort(
      (a, b) =>
        (a.status === "online") - (b.status === "online") ||
        String(a.name).localeCompare(String(b.name)),
    );
  }
  function renderFleet(devices) {
    const online = devices.filter((machine) => machine.status === "online").length;
    $("fleet-summary").textContent = `${numberFormat.format(online)} von ${numberFormat.format(devices.length)} online`;
    $("fleet-dots").replaceChildren(...sortedMachines(devices).map((machine) => node("span", `dot ${machine.status || "unknown"}`)));
    if (!devices.length) {
      const row = node("tr");
      const cell = node("td", "empty-state", "Noch kein Mac erfasst. Verbinde Max Monitor auf jedem Mac mit diesem Team-Server.");
      cell.colSpan = 6;
      row.append(cell);
      $("fleet-body").replaceChildren(row);
      return;
    }
    $("fleet-body").replaceChildren(...sortedMachines(devices).map((machine) => {
      const row = node("tr", `fleet-row ${machine.status || "unknown"}`);
      const label = machine.workerId || machine.name || "Mac";
      const nameCell = node("td");
      const name = node("div", "fleet-name");
      const signal = node("span", `dot ${machine.status || "unknown"}`);
      signal.title = statusNames[machine.status] || "Unbekannt";
      const identity = node("span");
      const open = node("button", "", label);
      open.type = "button";
      open.title = label;
      open.setAttribute("aria-label", `${label} · ${statusNames[machine.status] || "Unbekannt"} · Details`);
      const deviceName = machine.deviceName || (machine.name !== machine.workerId ? machine.name : null);
      open.title = [label, deviceName && deviceName !== label ? `macOS: ${deviceName}` : ""].filter(Boolean).join("\n");
      identity.append(open);
      if (!machine.workerId) identity.append(node("small", "", "ohne Worker-ID"));
      name.append(signal, identity);
      nameCell.append(name);
      const active = runningTasks(machine);
      const taskCell = node("td");
      const current = node("span", active.length ? "fleet-task" : "fleet-task idle",
        active.length ? active[0].title || active[0].id : machine.status === "online" ? "frei" : "—");
      if (active.length) current.title = active.map((task) => task.title || task.id).join("\n");
      taskCell.append(current);
      if (active.length > 1) taskCell.append(node("span", "fleet-sub", `+ ${active.length - 1} weitere`));
      const [battery, source] = batteryText(machine);
      const batteryCell = node("td", "fleet-battery", battery);
      if (source && source !== "Akku") batteryCell.append(node("small", "", ` · ${source}`));
      const account = machineAccount(machine);
      const stale = usageStale(machine);
      const sessionCell = node("td");
      const weeklyCell = node("td");
      if (account) {
        sessionCell.append(meter(machineLimit(machine, account, "session"), stale));
        weeklyCell.append(meter(machineLimit(machine, account, "weekly"), stale));
        if (stale) sessionCell.title = weeklyCell.title = `Letzte Messung ${relative(machine.usageUpdatedAt)}`;
      } else {
        const unbound = node("span", "fleet-unbound", "kein Account");
        unbound.title = "Monitoring-Account auf diesem Worker-Mac verbinden";
        sessionCell.append(unbound);
        weeklyCell.append(node("span", "fleet-unbound", "—"));
      }
      const seenAt = machine.receivedAt || machine.seenAt || machine.lastSeenAt;
      const seen = node("td", "fleet-seen", relative(seenAt).replace(/^vor /, ""));
      seen.title = exact(seenAt);
      row.append(nameCell, taskCell, batteryCell, sessionCell, weeklyCell, seen);
      row.addEventListener("click", () => machineDetails(machine));
      return row;
    }));
  }
  function renderOverview(devices, items, attention) {
    renderPipeline(items);
    renderAttention(attention);
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
      const card = node("article", `machine ${machine.status || "unknown"}`);
      const title = node("div", "machine-title");
      const identity = node("div", "machine-name");
      const label = machine.workerId || machine.name || "Mac";
      const machineName = node("h3", "", label);
      machineName.title = label;
      const deviceName = machine.deviceName || (machine.name !== machine.workerId ? machine.name : null);
      const subtitle = node("small", "", !machine.workerId ? "Worker-ID nicht zugeordnet"
        : deviceName ? `macOS: ${deviceName}` : "Wie in Slack");
      subtitle.title = subtitle.textContent;
      identity.append(machineName, subtitle);
      const signal = badge(machine.status);
      if (machine.telemetrySource === "worker")
        signal.textContent = `Worker ${statusNames[machine.status]?.toLowerCase() || machine.status}`;
      title.append(identity, signal);
      const data = node("div", "machine-data");
      const [battery, source] = batteryText(machine);
      const active = runningTasks(machine);
      const seenAt = machine.receivedAt || machine.seenAt || machine.lastSeenAt;
      for (const [name, value, hint, tooltip] of [
        ["Akku", battery, source === "Akku" ? "" : source],
        ["Aufgaben", `${active.length} aktiv`, ""],
        ["Meldung", relative(seenAt).replace(/^vor /, ""), "", exact(seenAt)],
      ]) {
        const datum = node("div");
        const text = node("span", "datum-value", value);
        if (hint) text.append(node("small", "", ` · ${hint}`));
        if (tooltip) text.title = tooltip;
        datum.append(node("span", "datum-label", name), text);
        data.append(datum);
      }
      card.append(title, data);
      const account = machineAccount(machine);
      const accountLabel = node("p", account ? "machine-account" : "machine-account unbound", account
        ? `Claude · ${account.name}` : "Kein Monitoring-Account verbunden");
      accountLabel.title = account?.name || "Monitoring-Account auf diesem Worker-Mac verbinden";
      card.append(accountLabel);
      if (account) {
        const limitGroup = node("div", "machine-limits");
        for (const [name, kind] of [["5-Stunden-Limit", "session"], ["Wochenlimit", "weekly"]]) {
          const value = machineLimit(machine, account, kind)?.percent ?? null;
          const limit = node("div", "machine-limit");
          const line = node("div", "usage-line");
          line.append(node("span", "", name), node("strong", "", value == null ? "—" : `${value} %`));
          const track = node("div", "usage-track");
          const fill = node("div", `usage-fill ${value >= 100 ? "full" : value >= 80 ? "high" : ""}`);
          fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
          track.append(fill);
          limit.append(line, track);
          limitGroup.append(limit);
        }
        card.append(limitGroup);
        const limits = machine.limits || [];
        if (!limits.length || usageStale(machine) || machine.usageError)
          card.append(node("p", "usage-note", machine.usageError ||
            (!limits.length ? "Claude-Kontingente noch nicht gemeldet." : `Kontingente veraltet · ${relative(machine.usageUpdatedAt)}`)));
      }
      if (machine.workerStatus && machine.workerStatus !== "online")
        card.append(node("p", "usage-note",
          `Newsletter-Worker: ${statusNames[machine.workerStatus] || machine.workerStatus} · ${relative(machine.workerLastSeenAt)}`));
      const bottom = node("div", "machine-bottom");
      const current = node("span", "machine-current", active.length ? active[0].title || active[0].id : "Keine laufende Aufgabe");
      current.title = current.textContent;
      const detail = node("button", "text-button", "Details ↗");
      detail.setAttribute("aria-label", `Details für ${label}`);
      detail.addEventListener("click", () => machineDetails(machine));
      bottom.append(current, detail);
      card.append(bottom);
      $("machine-grid").append(card);
    });
  }
  function filtered(items) {
    const workerNames = new Map(machines().filter(machine => machine.workerId).map(machine => [machine.workerId, [machine.name, machine.deviceName].filter(Boolean).join(" ")]));
    const needle = query.trim().toLocaleLowerCase();
    return items
      .filter((task) => {
        if (
          statusFilter === "open"
            ? !isOpen(task)
            : statusFilter !== "all" && task.status !== statusFilter
        )
          return false;
        if (workerFilter && task.workerId !== workerFilter) return false;
        if (workflowFilter && task.workflow !== workflowFilter) return false;
        return (
          !needle ||
          [task.title, task.id, task.company, task.workerId, workerNames.get(task.workerId), task.url, task.phase, ...(task.tags || [])]
            .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle)
        );
      })
      .sort(
        (a, b) =>
          (({ running: 0, blocked: 1, failed: 2, queued: 3, completed: 4 })[
            a.status
          ] ?? 5) -
            ({ running: 0, blocked: 1, failed: 2, queued: 3, completed: 4 }[
              b.status
            ] ?? 5) || String(a.title).localeCompare(String(b.title)),
      );
  }
  function canComplete(task) {
    return task && ["blocked", "failed"].includes(task.status) && task.taskVersion;
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
    const visible = filtered(items);
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
        : "Keine Aufgaben für diesen Filter.";
    $("result-count").textContent = snapshot
      ? `${visible.length} von ${items.length} Aufgaben`
      : "Noch keine Queue-Daten";
    pageTasks.forEach((task) => {
      const row = node("tr");
      const titleCell = node("td");
      const url = safeLink(task.url);
      const title = node(
        url ? "a" : "span",
        "task-title",
        task.title || task.id,
      );
      title.title = task.title || task.id;
      if (url) {
        title.href = url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }
      titleCell.append(title);
      if (task.company) {
        const company = node("span", "task-company", task.company);
        company.title = task.company;
        titleCell.append(company);
      }
      titleCell.append(node("span", "task-id", task.id));
      const category = node("td");
      category.append(node("span", "workflow-name", workflow(task.workflow)));
      const state = node("td");
      const status = badge(task.status);
      if (task.completion === "manual") status.lastChild.textContent = "Erledigt";
      state.append(status);
      const assigned = node("td");
      const assignment = node("div", "progress");
      assignment.append(
        node("span", "", task.workerId || "Noch nicht zugewiesen"),
      );
      if (Number.isFinite(task.progress)) {
        const track = node("div", "usage-track");
        const fill = node("div", "usage-fill");
        fill.style.width = `${Math.min(100, Math.max(0, task.progress))}%`;
        track.append(fill);
        assignment.append(track, node("span", "", `${task.progress} %`));
      }
      assigned.append(assignment);
      if (task.phase) assigned.append(node("span", "phase", task.phase));
      const updated = node("td");
      const time = node("time", "row-time", relative(task.updatedAt));
      time.title = exact(task.updatedAt);
      if (timestamp(task.updatedAt)) time.dateTime = task.updatedAt;
      updated.append(time);
      const actions = node("td");
      const actionGroup = node("div", "queue-actions");
      const links = node("div", "task-links");
      for (const [label, value] of [["ClickUp", task.url], ["Figma", task.figmaUrl]]) {
        const href = safeLink(value);
        if (!href) continue;
        const link = node("a", "text-button", `${label} ↗`);
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `${label === "Figma" ? "Figma-Board" : "ClickUp"} öffnen: ${task.title || task.id}`);
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
  function openDetail(title, children) {
    $("detail-title").textContent = title;
    $("detail-body").replaceChildren(...children);
    $("detail-action-error").hidden = true;
    $("detail-dialog").showModal();
  }
  function taskDetails(task) {
    const grid = node("div", "detail-grid");
    grid.append(
      detailField("Unternehmen", task.company || "Nicht hinterlegt"),
      detailField("Workflow", workflow(task.workflow)),
      detailField("Status", task.completion === "manual" ? "Manuell erledigt" : statusNames[task.status] || task.status),
      detailField("Worker", task.workerId || "Noch nicht zugewiesen"),
      detailField(
        "Fortschritt",
        Number.isFinite(task.progress)
          ? `${task.progress} %`
          : "Nicht gemeldet",
      ),
      detailField(
        "Letzter Schritt",
        task.phase || "Noch kein Schritt gemeldet",
        true,
      ),
      detailField("ClickUp-Status", task.sourceStatus || "Unbekannt"),
      detailField("Aktualisiert", exact(task.updatedAt)),
    );
    const tags = node("div", "detail-tags");
    (task.tags || []).forEach((tag) =>
      tags.append(node("span", "workflow-name", tag)),
    );
    const children = [node("p", "", task.id), grid, tags];
    const url = safeLink(task.url);
    if (url) {
      const link = node("a", "button primary", "In ClickUp öffnen ↗");
      link.href = url;
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
    if (task.completion === "manual") grid.append(detailField("Abgehakt", exact(task.completedAt)));
    if (canComplete(task)) children.push(completionButton(task, true));
    openDetail(task.title || task.id, children);
  }
  function machineDetails(machine) {
    const account = (machine.accounts || []).find((item) => item.accountId === machine.monitoringAccountId);
    const grid = node("div", "detail-grid");
    grid.append(
      detailField("macOS-Gerätename", machine.deviceName || (machine.name !== machine.workerId ? machine.name : null) || "Nicht gemeldet"),
      detailField("Erreichbarkeit", statusNames[machine.status] || "Unbekannt"),
      detailField(
        "Letzte Geräte-Meldung",
        exact(machine.receivedAt || machine.seenAt || machine.lastSeenAt),
      ),
      detailField(
        "Mac in Slack",
        machine.workerId || "Noch nicht mit einer Worker-ID verbunden",
        true,
      ),
      detailField(
        "Version",
        machine.appVersion || machine.workerVersion || "Unbekannt",
      ),
      detailField("Monitoring-Account", account ? `Claude · ${account.name}` : "Auf diesem Worker-Mac unter Queue & Macs → Monitoring-Account verbinden", true),
      detailField("Kontingente geprüft", exact(machine.usageUpdatedAt)),
      detailField(
        "Always On",
        machine.stayAwakeEnabled == null
          ? "Nicht gemeldet"
          : machine.stayAwakeEnabled
            ? "Aktiv"
            : "Aus",
      ),
    );
    if (Number.isInteger(machine.pendingClickup))
      grid.append(
        detailField("ClickUp-Updates ausstehend", machine.pendingClickup),
      );
    if (machine.workerLastSeenAt)
      grid.append(
        detailField(
          "Newsletter-Worker gemeldet",
          exact(machine.workerLastSeenAt),
        ),
      );
    const list = node("div");
    (machine.limits || []).forEach((limit) => {
      const line = node("div", "usage-line");
      line.append(
        node(
          "span",
          "",
          `${limit.accountName || limit.accountId} · ${limit.label || limit.kind}`,
        ),
        node("strong", "", `${limit.percent} % genutzt`),
      );
      list.append(line);
      list.append(
        node(
          "p",
          limit.usageStale || limit.usageStatus === "error"
            ? "usage-note"
            : "form-hint",
          `${limit.usageError || (limit.usageStale ? "Veraltete Messung" : "Geprüft")} · ${exact(limit.usageUpdatedAt || machine.usageUpdatedAt)}`,
        ),
      );
      if (limit.resetsAt)
        list.append(node("p", "form-hint", `Reset: ${exact(limit.resetsAt)}`));
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
            `${account.name}: ${account.usageError || "Noch keine Kontingente gemeldet"}`,
          ),
        );
    }
    const children = [grid, list];
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
    openDetail(machine.name || machine.workerId || "Mac", children);
  }
  function logRows(attention) {
    if (logFilter === "attention") {
      return attention.map((entry) => {
        const entity = entry.entity;
        const task = entry.type === "task";
        return {
          type: task ? "task" : "machine",
          title: task ? entity.title || entity.id : entity.name || entity.workerId || "Mac",
          id: task ? entity.id : entity.workerId || entity.deviceId,
          kind: task ? workflow(entity.workflow) : "Mac",
          workerId: entity.workerId,
          at: task ? entity.updatedAt : entity.receivedAt || entity.lastSeenAt,
          status: entity.status,
          statusLabel: statusNames[entity.status] || "Unbekannt",
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
        title: type === "machine" ? workerId || event.title || entity?.name || "Mac"
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
      detailField(row.currentWorker ? "Mac · aktuelle Zuordnung" : "Mac", row.workerId || "Nicht zugeordnet"),
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
        [row.title, row.id, row.kind, row.workerId, row.entity?.deviceName, row.statusLabel, row.phase, ...row.messages]
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
      const workerName = node("span", "log-worker-name", row.workerId || (row.type === "source" ? "—" : "Nicht zugeordnet"));
      workerName.title = row.workerId || "";
      worker.append(workerName);
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
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        selectView(
          button.dataset.view,
          button.dataset.status,
          button.dataset.logFilter,
        ),
      ),
    );
  document.querySelectorAll("#status-tabs .tab").forEach((button) =>
    button.addEventListener("click", () => {
      statusFilter = button.dataset.status;
      queuePage = 0;
      saveFilters();
      render();
    }),
  );
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
  $("connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    stopLive();
    fetchController?.abort();
    generation++;
    busy = false;
    credentials = {
      teamId: $("team-id").value.trim().toUpperCase(),
      token: $("team-token").value.trim(),
    };
    snapshot = null;
    const success = await refresh();
    $("team-token").value = "";
    if (success) {
      startLive();
      $("connection-dialog").close();
      $("disconnect").hidden = false;
    }
  });
  $("disconnect").addEventListener("click", () => {
    stopLive();
    generation++;
    fetchController?.abort();
    fetchController = null;
    busy = false;
    credentials = null;
    snapshot = null;
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
    if (!document.hidden) refresh();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopLive();
    else { refresh(); startLive(); }
  });
  window.addEventListener("pagehide", stopLive);
  window.addEventListener("pageshow", () => {
    if (!document.hidden) { refresh(); startLive(); }
  });
})();
