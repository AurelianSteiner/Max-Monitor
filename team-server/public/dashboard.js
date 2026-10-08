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
  const timeFormat = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const numberFormat = new Intl.NumberFormat("de-DE");
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
  function loading() {
    if (snapshot) return;
    $("machine-grid").replaceChildren(
      ...Array.from({ length: 3 }, () => {
        const shell = node("div", "machine");
        shell.append(
          node("div", "loading-line"),
          node("div", "loading-line"),
          node("div", "loading-line"),
        );
        shell.setAttribute("aria-label", "Geräte werden geladen");
        return shell;
      }),
    );
  }
  function syncStatus() {
    if (!snapshot || busy || !$('connection-error').hidden) return;
    $('sync-status').textContent = `${streamConnected ? 'Live' : 'Abgleich'} · ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(snapshotReceivedAt))}`;
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
    $("sync-status").textContent = "Aktualisiert…";
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
      $("sync-status").textContent =
        `${streamConnected ? "Live" : "Abgleich"} · ${new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
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
      $("sync-status").textContent = "Verbindung gestört";
      showNotice(
        snapshot
          ? `${message} Angezeigt wird der letzte geladene Stand.`
          : message,
      );
      if (snapshot) render();
      $("connection-error").textContent = message;
      $("connection-error").hidden = false;
      if (!snapshot)
        $("machine-grid").replaceChildren(
          node(
            "div",
            "empty-state",
            "Gerätedaten konnten nicht geladen werden. Prüfe dein Token unter „Verbindung anzeigen“.",
          ),
        );
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
    $("metric-online").textContent = snapshot
      ? devices.filter((x) => x.status === "online").length
      : "—";
    $("metric-total").textContent = snapshot
      ? `${devices.length} Macs insgesamt`
      : "Noch keine Gerätedaten";
    $("metric-running").textContent = snapshot
      ? items.filter((x) => x.status === "running").length
      : "—";
    $("metric-queued").textContent = snapshot
      ? items.filter((x) => x.status === "queued").length
      : "—";
    const quiet = attention.filter((entry) => entry.type === "machine").length;
    const blocked = attention.filter((entry) => entry.type === "task").length;
    $("metric-attention").textContent = snapshot ? quiet + blocked : "—";
    $("metric-attention-detail").textContent = snapshot
      ? `${quiet} Macs · ${blocked} Aufgaben`
      : "Betroffene Macs & Aufgaben anzeigen";
    $("log-attention-count").textContent = snapshot ? attention.length : "—";
    $("nav-queue").textContent = snapshot ? items.filter(isOpen).length : "—";
    $("nav-machines").textContent = snapshot ? devices.length : "—";
    $("machine-count").textContent = devices.length;
    $("queue-count").textContent = items.length;
    const statusCounts = {
      open: items.filter(isOpen).length,
      running: items.filter((task) => task.status === "running").length,
      queued: items.filter((task) => task.status === "queued").length,
      blocked: items.filter((task) => task.status === "blocked").length,
      all: items.length,
    };
    for (const [status, count] of Object.entries(statusCounts)) {
      const label = $(`${status}-count`);
      if (label) label.textContent = numberFormat.format(count);
    }
    $("page-title").textContent =
      {
        overview: "Alles im Blick.",
        queue: "Was als Nächstes dran ist.",
        machines: "Deine Mac-Worker.",
        log:
          logFilter === "attention"
            ? "Hier braucht es einen Blick."
            : "Was sich verändert hat.",
      }[view] || "Alles im Blick.";
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("selected", button.dataset.view === view);
      button.setAttribute(
        "aria-current",
        button.dataset.view === view ? "page" : "false",
      );
    });
    $("machines-section").hidden = ["queue", "log"].includes(view);
    $("queue-section").hidden = ["machines", "log"].includes(view);
    $("log-section").hidden = view !== "log";
    document.querySelector(".metrics").hidden = view === "log";
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
    $("log-description").textContent =
      logFilter === "attention"
        ? "Betroffene Macs und Aufgaben mit dem aktuellen Grund."
        : "Neue Aufgaben, Statuswechsel und Meldungen der Geräte.";
    $("worker-filter").hidden = !workerFilter;
    $("worker-filter-label").textContent = `Aufgaben für ${workerFilter}`;
    $("team-label").textContent = credentials
      ? `Team ${credentials.teamId} · ${location.host}`
      : "Gemeinsamer Team-Server";
    $("queue-updated").textContent = snapshot?.queue?.source?.lastSuccessAt
      ? `Queue · ${relative(snapshot.queue.source.lastSuccessAt)}`
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
    if (snapshot) renderMachines(devices);
    renderQueue(items);
    renderEvents(attention);
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
    devices
      .slice()
      .sort(
        (a, b) =>
          (a.status === "online") - (b.status === "online") ||
          String(a.name).localeCompare(String(b.name)),
      )
      .forEach((machine) => {
        const card = node("article", `machine ${machine.status || "unknown"}`);
        const title = node("div", "machine-title");
        title.append(node("span", "computer-icon"));
        title.firstChild.setAttribute("aria-hidden", "true");
        const identity = node("div", "machine-name");
        const machineName = node(
          "h3",
          "",
          machine.workerId || machine.name || "Mac",
        );
        machineName.title = machine.workerId || machine.name || "Mac";
        const deviceName = machine.deviceName || (machine.name !== machine.workerId ? machine.name : null);
        const subtitle = node("small", "", !machine.workerId ? "Worker-ID nicht zugeordnet"
          : deviceName ? `macOS: ${deviceName}` : "Wie in Slack");
        subtitle.title = subtitle.textContent;
        identity.append(machineName, subtitle);
        const signal = badge(machine.status);
        if (machine.telemetrySource === "worker")
          signal.lastChild.textContent = `Worker ${statusNames[machine.status]?.toLowerCase() || machine.status}`;
        title.append(identity, signal);
        card.append(title);
        const data = node("div", "machine-data");
        const battery = node("div");
        battery.append(node("span", "datum-label", "Akku"));
        const batteryValue = node(
          "span",
          "datum-value",
          machine.batteryPercent == null
            ? "Unbekannt"
            : `${machine.batteryPercent} %`,
        );
        batteryValue.append(
          node(
            "small",
            "",
            machine.isCharging
              ? " · lädt"
              : ["ac", "AC", "AC Power", "mains"].includes(machine.powerSource)
                ? " · Netzteil"
                : machine.powerSource === "battery"
                  ? " · Batterie"
                  : "",
          ),
        );
        battery.append(batteryValue);
        const work = node("div");
        work.append(node("span", "datum-label", "Aufgaben"));
        const active = tasks().filter(
          (x) => x.workerId === machine.workerId && x.status === "running",
        );
        work.append(node("span", "datum-value", `${active.length} aktiv`));
        data.append(battery, work);
        card.append(data);
        const account = (machine.accounts || []).find((item) => item.accountId === machine.monitoringAccountId);
        const accountLabel = node("p", "machine-account meta", account
          ? `Claude · ${account.name}` : "Monitoring-Account nicht verbunden");
        accountLabel.title = account?.name || "Monitoring-Account auf diesem Worker-Mac verbinden";
        card.append(accountLabel);
        const limits = account && Array.isArray(machine.limits)
          ? machine.limits.filter((item) => item.accountId === account.accountId) : [];
        const session = limits.find((item) => item.kind === "session");
        const weekly = limits.find((item) => item.kind === "weekly");
        const limitGroup = node("div", "machine-limits");
        for (const [label, list] of [
          ["5-Stunden-Limit", session],
          ["Wochenlimit", weekly],
        ]) {
          const value = list?.percent ?? null;
          const limit = node("div", "machine-limit");
          const line = node("div", "usage-line");
          line.append(
            node("span", "", label),
            node("strong", "", value == null ? "—" : `${value} % genutzt`),
          );
          limit.append(line);
          const track = node("div", "usage-track");
          const fill = node(
            "div",
            `usage-fill ${value >= 100 ? "full" : value >= 80 ? "high" : ""}`,
          );
          fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
          track.append(fill);
          limit.append(track);
          limitGroup.append(limit);
        }
        card.append(limitGroup);
        if (!limits.length || usageStale(machine) || machine.usageError)
          card.append(
            node(
              "p",
              "usage-note",
              machine.usageError ||
                (!limits.length
                  ? (account ? "Claude-Kontingente noch nicht gemeldet." : "Monitoring-Account auf diesem Worker-Mac verbinden.")
                  : `Kontingente veraltet · ${relative(machine.usageUpdatedAt)}`),
            ),
          );
        if (machine.workerStatus && machine.workerStatus !== "online")
          card.append(
            node(
              "p",
              "usage-note",
              `Newsletter-Worker: ${statusNames[machine.workerStatus] || machine.workerStatus} · ${relative(machine.workerLastSeenAt)}`,
            ),
          );
        const bottom = node("div", "machine-bottom");
        const seen = node(
          "span",
          "",
          relative(machine.receivedAt || machine.seenAt || machine.lastSeenAt),
        );
        seen.title = exact(
          machine.receivedAt || machine.seenAt || machine.lastSeenAt,
        );
        const detail = node("button", "text-button", "Details ↗");
        detail.setAttribute(
          "aria-label",
          `Details für ${machine.name || machine.workerId || "Mac"}`,
        );
        detail.addEventListener("click", () => machineDetails(machine));
        bottom.append(seen, detail);
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
      $(view === "log" ? "log-heading" : "queue-heading").focus({ preventScroll: true });
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
          kind: task ? workflow(entity.workflow) : "Mac-Worker",
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
          : type === "machine" ? "Mac-Worker" : "Queue-Quelle",
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
        : "Statuswechsel, neue Aufgaben und Meldungen der Macs im zeitlichen Verlauf.";
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
    $("sync-status").textContent = "Nicht verbunden";
    showNotice("");
    $("machine-grid").replaceChildren(
      node(
        "div",
        "empty-state",
        "Verbinde deinen Team-Server, um alle Macs zu sehen.",
      ),
    );
    render();
  });
  render();
  if (credentials) { refresh(); startLive(); }
  else $("connection-dialog").showModal();
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
