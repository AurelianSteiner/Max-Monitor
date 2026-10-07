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
  let busy = false;
  let fetchController = null;
  let generation = 0;
  const params = new URLSearchParams(location.search);
  let view = params.get("view") || "overview";
  let logFilter = params.get("log") === "attention" ? "attention" : "all";
  if (view === "attention") {
    view = "log";
    logFilter = "attention";
  }
  let statusFilter = params.get("status") || "open";
  let workerFilter = params.get("worker") || "";
  let workflowFilter = params.get("workflow") || "";
  let query = params.get("q") || "";
  let queuePage = 0;
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
      return url.protocol === "https:" ? url.href : null;
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
    if (!limits.length) reasons.push("Claude-Kontingente noch nicht gemeldet");
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
    if (statusFilter !== "open") state.set("status", statusFilter);
    if (workerFilter) state.set("worker", workerFilter);
    if (workflowFilter) state.set("workflow", workflowFilter);
    if (query) state.set("q", query);
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
    if (log) logFilter = log;
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
        `Live · ${new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
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
    $("open-count").textContent = items.filter(isOpen).length;
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
    $("log-summary").textContent = !snapshot
      ? "Noch keine Daten geladen."
      : logFilter === "attention"
        ? `${quiet} Macs · ${blocked} Aufgaben brauchen Aufmerksamkeit. Jeder Eintrag zählt einmal.`
        : `${Array.isArray(snapshot.events) ? snapshot.events.length : 0} Ereignisse · neueste zuerst`;
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
          machine.name || machine.workerId || "Mac",
        );
        machineName.title = machine.name || machine.workerId || "Mac";
        identity.append(
          machineName,
          node("small", "", machine.workerId || "Worker-ID nicht zugeordnet"),
        );
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
        const limits = Array.isArray(machine.limits) ? machine.limits : [];
        const session = limits.filter((x) => x.kind === "session");
        const weekly = limits.filter(
          (x) =>
            ["weekly", "modelWeekly", "accountWeekly"].includes(x.kind) ||
            String(x.kind).startsWith("model:"),
        );
        for (const [label, list] of [
          ["5-Stunden-Limit", session],
          ["Wochenlimit", weekly],
        ]) {
          const value = list.length
            ? Math.max(...list.map((x) => x.percent))
            : null;
          const line = node("div", "usage-line");
          line.append(
            node("span", "", label),
            node("strong", "", value == null ? "—" : `${value} % genutzt`),
          );
          card.append(line);
          const track = node("div", "usage-track");
          const fill = node(
            "div",
            `usage-fill ${value >= 100 ? "full" : value >= 80 ? "high" : ""}`,
          );
          fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
          track.append(fill);
          card.append(track);
        }
        if (!limits.length || usageStale(machine) || machine.usageError)
          card.append(
            node(
              "p",
              "usage-note",
              machine.usageError ||
                (!limits.length
                  ? "Claude-Kontingente noch nicht gemeldet."
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
          !query ||
          `${task.title} ${task.id} ${task.workerId || ""} ${task.phase || ""} ${(task.tags || []).join(" ")}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
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
      titleCell.append(title, node("span", "task-id", task.id));
      const category = node("td");
      category.append(node("span", "workflow-name", workflow(task.workflow)));
      const state = node("td");
      state.append(badge(task.status));
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
      const detail = node("button", "icon-button", "↗");
      detail.setAttribute("aria-label", `Details zu ${task.title || task.id}`);
      detail.addEventListener("click", () => taskDetails(task));
      actions.append(detail);
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
    $("detail-dialog").showModal();
  }
  function taskDetails(task) {
    const grid = node("div", "detail-grid");
    grid.append(
      detailField("Workflow", workflow(task.workflow)),
      detailField("Status", statusNames[task.status] || task.status),
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
    openDetail(task.title || task.id, children);
  }
  function machineDetails(machine) {
    const grid = node("div", "detail-grid");
    grid.append(
      detailField("Erreichbarkeit", statusNames[machine.status] || "Unbekannt"),
      detailField(
        "Letzte Geräte-Meldung",
        exact(machine.receivedAt || machine.seenAt || machine.lastSeenAt),
      ),
      detailField(
        "Worker-ID",
        machine.workerId || "In Max Monitor → Konten → Team hinterlegen",
        true,
      ),
      detailField(
        "Version",
        machine.appVersion || machine.workerVersion || "Unbekannt",
      ),
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
  function renderAttention(entries, list) {
    if (!entries.length) {
      list.append(
        node(
          "div",
          "empty-state",
          snapshot
            ? "Aktuell braucht kein Mac und keine Aufgabe Aufmerksamkeit."
            : "Verbinde den Team-Server, um betroffene Macs und Aufgaben zu sehen.",
        ),
      );
      return;
    }
    for (const entry of entries) {
      const entity = entry.entity;
      const task = entry.type === "task";
      const title = task
        ? entity.title || entity.id
        : entity.name || entity.workerId || "Mac";
      const line = node("article", "event attention-entry");
      line.dataset.attentionType = entry.type;
      const meta = node("div", "attention-meta");
      meta.append(
        node(
          "span",
          "attention-kind",
          task ? workflow(entity.workflow) : "Mac-Worker",
        ),
      );
      if (task || entity.status !== "online") meta.append(badge(entity.status));
      const detail = node("div", "attention-body");
      detail.append(node("h3", "", title));
      const reasons = node("ul", "attention-reasons");
      entry.reasons.forEach((reason) => reasons.append(node("li", "", reason)));
      detail.append(reasons);
      if (task && entity.phase)
        detail.append(node("p", "", `Letzter Schritt: ${entity.phase}`));
      detail.append(
        node(
          "p",
          "attention-context",
          task
            ? [entity.id, entity.workerId].filter(Boolean).join(" · ")
            : [entity.workerId, `Letzte Meldung ${relative(entity.lastSeenAt)}`]
                .filter(Boolean)
                .join(" · "),
        ),
      );
      const button = node("button", "icon-button", "↗");
      button.setAttribute("aria-label", `Details zu ${title}`);
      button.addEventListener("click", () =>
        task ? taskDetails(entity) : machineDetails(entity),
      );
      line.append(meta, detail, button);
      list.append(line);
    }
  }
  function renderEvents(attention) {
    const list = $("event-list");
    list.replaceChildren();
    if (logFilter === "attention") {
      renderAttention(attention, list);
      return;
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    if (!events.length) {
      list.append(
        node(
          "div",
          "empty-state",
          "Noch keine Ereignisse. Neue Meldungen und Queue-Änderungen erscheinen hier.",
        ),
      );
      return;
    }
    events
      .slice()
      .sort((a, b) => (timestamp(b.at) || 0) - (timestamp(a.at) || 0))
      .forEach((event) => {
        const line = node("div", "event");
        const time = node(
          "time",
          "",
          exact(event.at || event.receivedAt || event.timestamp),
        );
        const detail = node("div");
        detail.append(
          node(
            "strong",
            "",
            event.title
              ? `${event.title} · ${event.message || event.type || "Status aktualisiert"}`
              : event.message || event.type || "Status aktualisiert",
          ),
        );
        if (event.taskId || event.workerId)
          detail.append(
            node(
              "p",
              "",
              [event.taskId, event.workerId].filter(Boolean).join(" · "),
            ),
          );
        line.append(time, detail);
        list.append(line);
      });
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
  $("refresh").addEventListener("click", refresh);
  for (const id of ["connection-button", "connection-top"])
    $(id).addEventListener("click", () => {
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
      $("connection-dialog").close();
      $("disconnect").hidden = false;
    }
  });
  $("disconnect").addEventListener("click", () => {
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
  if (credentials) refresh();
  else $("connection-dialog").showModal();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
