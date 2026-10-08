//
// Max Monitor — Team-Relay
//
// Winziger Dienst ohne Abhängigkeiten. Vier Rollen:
//   super   Team-Inhaber (Token aus TEAM_TOKENS): verwaltet Mitglieder,
//           sieht alles inklusive der Mitglieds-Tokens.
//   admin   sieht alle Meldungen des Teams, verwaltet aber nichts.
//   guest   sieht das ganze Team und kann Aufgaben abhaken; meldet keinen Mac.
//   member  meldet die eigene Auslastung; sehen dürfen alle alles —
//           geteilt werden ohnehin nur freiwillige Prozentwerte.
//
// Gespeichert werden ausschließlich Prozentwerte, Labels und Reset-
// Zeitpunkte — niemals Session Keys, OAuth-Tokens, Chats oder andere
// Inhalte. Personenbezogen ist darin trotzdem etwas, und das sollte
// wissen, wer selbst hostet oder einem Team beitritt:
//   report.person  Anzeigename der Meldung. Gehört das Token zu einem
//                  Eintrag in members.json (member wie admin), setzt der
//                  Server unten den vom Inhaber vergebenen Namen ein. Zum
//                  Super-Token gibt es keinen solchen Eintrag — dann bleibt
//                  stehen, was die App schickt: der volle Mac-Benutzername
//                  aus NSFullUserName().
//   limit.label    Beschriftung einer Zeile („7 Tage"). Meldet jemand
//                  mehrere Konten, steht der Kontoname davor — und der ist
//                  bei OAuth-Konten ohne selbst vergebenen Alias die
//                  E-Mail-Adresse des Logins.
// Wer das nicht auf dem Server haben will, vergibt in der App je Konto
// einen Alias; der steht dann anstelle der E-Mail im Label.
//
// Umgebungsvariablen:
//   TEAM_TOKENS "TEAMID1:supertoken1,TEAMID2:supertoken2" — je Team genau
//               ein Super-Admin-Token. Neues Team = neuer Eintrag.
//   TEAM_TOKEN  Abkürzung: ein Super-Token, das für jedes Team gilt.
//   DATA_DIR    Ablage (Railway-Volume), Standard /data
//   PORT        von Railway gesetzt
//
// Endpunkte (alle außer /health mit "Authorization: Bearer <token>"):
//   GET    /health                              Lebenszeichen
//   GET    /v1/teams/:id/me                     wer bin ich? (Rolle, Name)
//   POST   /v1/teams/:id/members                Mitglied anlegen  {name, role?}   super
//   GET    /v1/teams/:id/members                Mitglieder auflisten              super (mit Token), admin (ohne)
//   DELETE /v1/teams/:id/members/:memberId      Mitglied entfernen                super
//   PATCH  /v1/teams/:id/members/:memberId      Rolle ändern {role}              super
//   POST   /v1/reports                          Meldung speichern                 jede Rolle (member: nur als sich selbst)
//   GET    /v1/teams/:id/reports                Meldungen lesen                   jede Rolle: alle
//   GET    /v1/teams/:id/members/:mid/history   Verlauf (?days=7, max 30)         jede Rolle: jeder
//
// Verlauf: Jede angenommene Meldung wird zusätzlich als eine Zeile
// {t, limits:[{label, kind?, percent}]} an history/<memberId>.ndjson
// angehängt und beim Schreiben auf 30 Tage / 3000 Zeilen gestutzt —
// die Grundlage für Auslastungs-Verläufe in der App.
//

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createFleetStore, FleetError, MAX_QUEUE_BODY_BYTES } = require("./fleet");
const { EnrollmentError, enrollWorkerMember } = require("./enrollment");

const PORT = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);
const HOST = process.env.HOST || undefined;
const DATA_DIR = process.env.DATA_DIR || "/data";
const fleet = createFleetStore(DATA_DIR);

const MAX_BODY_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Z0-9]{4,16}$/; // Team-IDs wie "4P074HZ1"

// Team-ID -> Super-Token. Leerer Schlüssel "" = Super-Token für jedes Team.
const superTokens = new Map();
for (const pair of String(process.env.TEAM_TOKENS || "").split(",")) {
  const idx = pair.indexOf(":");
  if (idx > 0) superTokens.set(pair.slice(0, idx).trim().toUpperCase(), pair.slice(idx + 1).trim());
}
if (process.env.TEAM_TOKEN) superTokens.set("", process.env.TEAM_TOKEN.trim());

if (superTokens.size === 0) {
  console.error("Weder TEAM_TOKENS noch TEAM_TOKEN gesetzt — Start verweigert.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ------------------------------------------------------------------ Helfer

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function tokenMatches(candidate, expected) {
  if (!expected || !candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  if (candidateBytes.length !== expectedBytes.length) return false;
  // Zeitkonstanter Vergleich, damit Tokens nicht über Antwortzeiten erratbar sind
  return crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function bearerToken(req) {
  const header = req.headers["authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/// Dateiname/ID aus einem Namen: nur [a-z0-9-], bricht nie aus DATA_DIR aus
function slug(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "anonym";
}

function teamDir(teamId) {
  return path.join(DATA_DIR, String(teamId).toUpperCase());
}

function readMembers(teamId, strict = false) {
  try {
    const raw = fs.readFileSync(path.join(teamDir(teamId), "members.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("ungültige Mitgliederdatei");
    return parsed;
  } catch (error) {
    if (strict && error.code !== "ENOENT") throw error;
    return []; // fehlende oder kaputte Datei = keine Mitglieder, kein Absturz
  }
}

function writeMembers(teamId, members) {
  fs.mkdirSync(teamDir(teamId), { recursive: true, mode: 0o700 });
  const file = path.join(teamDir(teamId), "members.json");
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(members), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/// Wer ruft an? -> { role: "super"|"admin"|"member"|"guest", member? } oder null
function identify(req, teamId) {
  const token = bearerToken(req);
  if (!token) return null;
  const id = String(teamId || "").toUpperCase();
  if (tokenMatches(token, superTokens.get(id)) || tokenMatches(token, superTokens.get(""))) {
    return { role: "super" };
  }
  for (const member of readMembers(id)) {
    if (tokenMatches(token, member.token)) {
      return { role: ["admin", "guest"].includes(member.role) ? member.role : "member", member };
    }
  }
  return null;
}

function validReport(report) {
  if (typeof report !== "object" || report === null) return "kein Objekt";
  if (!ID_PATTERN.test(String(report.teamId || "").toUpperCase())) return "teamId fehlt oder ungültig";
  if (typeof report.person !== "string" || !report.person.trim()) return "person fehlt";
  if (!Array.isArray(report.limits) || report.limits.length === 0) return "limits fehlen";
  for (const limit of report.limits) {
    if (typeof limit !== "object" || limit === null) return "limit ist kein Objekt";
    if (typeof limit.label !== "string") return "limit.label fehlt";
    const percent = Number(limit.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 1000) return "limit.percent ungültig";
  }
  return null;
}

function readBody(req, callback, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  let finished = false;
  function finish(error, raw) {
    if (finished) return;
    finished = true;
    callback(error, raw);
  }
  req.on("data", (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > maxBytes) {
      finish(new Error("zu groß"), null);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
  req.on("error", (error) => finish(error, null));
}

function fleetResult(res, operation) {
  try {
    return send(res, 200, operation());
  } catch (error) {
    return send(res, error instanceof FleetError ? error.status : 500, { error: error instanceof FleetError ? error.message : "Fleet-Anfrage fehlgeschlagen" });
  }
}

const fleetStreams = new Map();
function streamFleet(req, res, teamId) {
  try { fleet.snapshot(teamId); }
  catch (error) {
    return send(res, error instanceof FleetError ? error.status : 500,
      { error: error instanceof FleetError ? error.message : "Fleet konnte nicht gelesen werden" });
  }
  const clients = fleetStreams.get(teamId) || new Set();
  if (clients.size >= 200) return send(res, 429, { error: "Zu viele Live-Verbindungen" });
  fleetStreams.set(teamId, clients);
  clients.add(res);
  let closed = false;
  let timer;
  let unsubscribe = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(timer);
    clients.delete(res);
    if (!clients.size) fleetStreams.delete(teamId);
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  const write = (message) => {
    if (closed) return;
    // Recheck membership on every update and heartbeat, including revocations.
    if (!identify(req, teamId) || res.destroyed || !res.write(message)) close();
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Connection": "keep-alive",
  });
  res.on("close", close);
  res.on("error", close);
  unsubscribe = fleet.subscribe(teamId, () => write("event: fleet\ndata: {}\n\n"));
  timer = setInterval(() => write(": heartbeat\n\n"), 15000);
  timer.unref();
  // The initial invalidation closes the gap between a GET and subscribing.
  write("retry: 5000\nevent: fleet\ndata: {}\n\n");
}

function serveFleetAsset(req, res, pathname) {
  const routes = new Map([
    ["/fleet", ["dashboard.html", "text/html; charset=utf-8"]],
    ["/monitor", ["dashboard.html", "text/html; charset=utf-8"]],
    ["/fleet-assets/dashboard.css", ["dashboard.css", "text/css; charset=utf-8"]],
    ["/fleet-assets/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ]);
  const asset = routes.get(pathname);
  if (req.method !== "GET" || !asset) return false;
  try {
    const data = fs.readFileSync(path.join(__dirname, "public", asset[0]));
    res.writeHead(200, {
      "content-type": asset[1],
      "content-length": data.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(data);
  } catch {
    send(res, 404, { error: "Dashboard-Datei fehlt" });
  }
  return true;
}

// ------------------------------------------------------------------ Verlauf

const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
const HISTORY_MAX_LINES = 3000; // weit über 30 Tagen à <=96 Meldungen

function historyPath(teamId, fileId) {
  return path.join(teamDir(teamId), "history", `${fileId}.ndjson`);
}

/// Eine angenommene Meldung als kompakte Verlaufszeile anhängen. Scheitert
/// das, ist nur der Verlauf lückenhaft — die Meldung selbst ist gespeichert.
function appendHistory(teamId, fileId, report) {
  const sample = {
    t: report.receivedAt,
    limits: (report.limits || []).map((limit) => ({
      label: limit.label,
      ...(typeof limit.kind === "string" ? { kind: limit.kind } : {}),
      percent: Number(limit.percent),
    })),
  };
  const file = historyPath(teamId, fileId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(sample) + "\n");
    pruneHistory(file);
  } catch (error) {
    console.error("Verlauf schreiben fehlgeschlagen:", error.message);
  }
}

/// Beim Schreiben stutzen: Bei höchstens ~96 Meldungen pro Tag ist das
/// Neuschreiben der kleinen Datei billiger als jede Buchhaltung daneben.
function pruneHistory(file) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const kept = lines
    .filter((line) => {
      try {
        const t = Date.parse(JSON.parse(line).t);
        return Number.isFinite(t) && t >= cutoff;
      } catch {
        return false;
      }
    })
    .slice(-HISTORY_MAX_LINES);
  if (kept.length !== lines.length) {
    fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
  }
}

function readHistory(teamId, memberId, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const file = historyPath(teamId, memberId);
  const samples = [];
  try {
    if (!fs.existsSync(file)) return samples;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        const t = Date.parse(sample.t);
        if (Number.isFinite(t) && t >= cutoff) samples.push(sample);
      } catch {
        // kaputte Zeile überspringen
      }
    }
  } catch (error) {
    console.error("Verlauf lesen fehlgeschlagen:", error.message);
  }
  return samples;
}

function readReports(teamId) {
  const dir = path.join(teamDir(teamId), "reports");
  const reports = [];
  try {
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        if (raw.length > MAX_BODY_BYTES) continue;
        reports.push(JSON.parse(raw));
      } catch {
        // Eine kaputte Datei darf die anderen nicht blockieren
      }
    }
  } catch (error) {
    console.error("Lesen fehlgeschlagen:", error.message);
  }
  reports.sort((a, b) => String(b.reportedAt || "").localeCompare(String(a.reportedAt || "")));
  return reports;
}

// Access to the team is separate from participation as a reporting Mac. Keep
// stored telemetry intact so changing a role is reversible, but omit guests'
// devices (including their old liveness events) from every shared snapshot.
function visibleFleet(teamId) {
  const guests = new Set(readMembers(teamId).filter((member) => member.role === "guest").map((member) => member.id));
  const snapshot = fleet.snapshot(teamId);
  const hiddenDevices = new Set(snapshot.machines.filter((machine) => guests.has(machine.memberId)).map((machine) => machine.deviceId));
  return {
    ...snapshot,
    machines: snapshot.machines.filter((machine) => !hiddenDevices.has(machine.deviceId)),
    events: snapshot.events.filter((entry) => !hiddenDevices.has(entry.deviceId || entry.entityId)),
  };
}

// ------------------------------------------------------------------ Server

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, { error: "ungültiger Pfad" }); }

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }
  if (serveFleetAsset(req, res, url.pathname)) return;

  // POST /v1/reports — Meldung speichern
  if (req.method === "POST" && url.pathname === "/v1/reports") {
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "Meldung zu groß" });
      let report;
      try {
        report = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "kein gültiges JSON" });
      }
      const problem = validReport(report);
      if (problem) return send(res, 400, { error: problem });

      const who = identify(req, report.teamId);
      if (!who) return send(res, 401, { error: "Token fehlt oder passt nicht zum Team" });
      if (who.role === "guest") return send(res, 403, { error: "Gäste melden keinen eigenen Mac und keine Kontingente" });

      // Mitglieder melden immer unter ihrem eingetragenen Namen —
      // niemand kann unter fremdem Namen melden.
      if (who.member) {
        report.person = who.member.name;
        report.memberId = who.member.id;
      }
      report.receivedAt = new Date().toISOString();
      if (!report.reportedAt) report.reportedAt = report.receivedAt;

      const dir = path.join(teamDir(report.teamId), "reports");
      const fileId = who.member ? who.member.id : slug(report.person);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${fileId}.json`), JSON.stringify(report));
      } catch (writeError) {
        console.error("Schreiben fehlgeschlagen:", writeError.message);
        return send(res, 500, { error: "Speichern fehlgeschlagen" });
      }
      appendHistory(report.teamId, fileId, report);
      return send(res, 200, { ok: true, person: report.person });
    });
  }

  // Alles Weitere hängt an /v1/teams/:id/…
  const teamMatch = url.pathname.match(/^\/v1\/teams\/([A-Za-z0-9]{4,16})(\/.*)?$/);
  if (!teamMatch) return send(res, 404, { error: "unbekannter Pfad" });
  const teamId = teamMatch[1].toUpperCase();
  const rest = teamMatch[2] || "";

  const who = identify(req, teamId);
  if (!who) return send(res, 401, { error: "Token fehlt oder passt nicht zum Team" });

  // Only the trusted Hub enrollment command holds the owner token. An enrolled
  // worker always receives its own ordinary member token, never owner rights.
  if (rest === "/workers/enroll" && (req.method === "GET" || req.method === "POST")) {
    if (who.role !== "super") return send(res, 403, { error: "nur der Team-Inhaber darf Worker registrieren" });
    if (req.method === "GET") return send(res, 200, { schema: 1, role: "member", maxWorkers: 200 });
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "Registrierung zu groß" });
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "kein gültiges JSON" }); }
      try {
        // The complete read/check/write stays synchronous, so simultaneous
        // requests in this relay instance cannot create duplicate identities.
        const result = enrollWorkerMember(body, {
          read: () => readMembers(teamId, true),
          write: (members) => writeMembers(teamId, members),
        });
        return send(res, 200, { schema: 1, ...result });
      } catch (enrollmentError) {
        return send(res, enrollmentError instanceof EnrollmentError ? enrollmentError.status : 500,
          { error: enrollmentError instanceof EnrollmentError ? enrollmentError.message : "Worker-Registrierung konnte nicht gespeichert werden" });
      }
    });
  }

  // Fleet and queue are shared by all authenticated team members. Only the
  // queue bridge/admin can replace a complete task snapshot.
  if (req.method === "GET" && rest === "/fleet/events") {
    return streamFleet(req, res, teamId);
  }
  if (req.method === "GET" && rest === "/fleet") {
    return fleetResult(res, () => visibleFleet(teamId));
  }
  // Every team member can resolve an attention item; source synchronization
  // remains restricted to the queue bridge/admin.
  if (req.method === "POST" && rest === "/fleet/tasks/complete") {
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "Abhak-Anfrage zu groß" });
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "kein gültiges JSON" }); }
      return fleetResult(res, () => ({ ok: true, task: fleet.completeTask(teamId, who, body) }));
    });
  }
  // Every team member can resolve an attention item; source synchronization
  // remains restricted to the queue bridge/admin.
  if (req.method === "POST" && rest === "/fleet/tasks/complete") {
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "Abhak-Anfrage zu groß" });
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "kein gültiges JSON" }); }
      return fleetResult(res, () => ({ ok: true, task: fleet.completeTask(teamId, who, body) }));
    });
  }
  if (req.method === "POST" && (rest === "/heartbeat" || rest === "/queue")) {
    if (rest === "/heartbeat" && who.role === "guest") return send(res, 403, { error: "Gäste registrieren keinen Worker-Mac" });
    if (rest === "/queue" && !["admin", "super"].includes(who.role)) return send(res, 403, { error: "nur Admin oder Team-Inhaber darf die Queue aktualisieren" });
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "Fleet-Meldung zu groß" });
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "kein gültiges JSON" }); }
      if (rest === "/heartbeat" && who.member?.enrollment &&
        (String(body?.deviceId || "").toLowerCase() !== who.member.enrollment.deviceId || body?.workerId !== who.member.enrollment.workerId)) {
        return send(res, 409, { error: "Worker-Token ist an die registrierte Geräte-ID und Worker-ID gebunden" });
      }
      return fleetResult(res, () => rest === "/heartbeat"
        ? { ok: true, machine: fleet.heartbeat(teamId, who, body) }
        : { ok: true, ...fleet.updateQueue(teamId, body) });
    }, rest === "/queue" ? MAX_QUEUE_BODY_BYTES : MAX_BODY_BYTES);
  }

  // GET /v1/teams/:id/me — Rolle des Tokens (die App erkennt daran den Modus)
  if (req.method === "GET" && rest === "/me") {
    return send(res, 200, {
      role: who.role,
      name: who.member ? who.member.name : null,
      memberId: who.member ? who.member.id : null,
    });
  }

  // GET /v1/teams/:id/reports — jede Rolle sieht alle Meldungen. Wer seine
  // Auslastung teilt, bekommt die Übersicht auch zurück; der frühere Filter
  // auf die eigene Meldung nahm Mitgliedern genau den Anreiz dafür.
  if (req.method === "GET" && rest === "/reports") {
    const guests = new Set(readMembers(teamId).filter((member) => member.role === "guest").map((member) => member.id));
    return send(res, 200, { reports: readReports(teamId).filter((report) => !guests.has(report.memberId)) });
  }

  // POST /v1/teams/:id/members — Mitglied anlegen (nur Super-Admin)
  if (req.method === "POST" && rest === "/members") {
    if (who.role !== "super") return send(res, 403, { error: "nur der Team-Inhaber darf Mitglieder anlegen" });
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "zu groß" });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "kein gültiges JSON" });
      }
      const name = String(body.name || "").trim();
      if (!name) return send(res, 400, { error: "name fehlt" });
      const role = body.role === undefined ? "member" : body.role;
      if (!["member", "admin", "guest"].includes(role)) return send(res, 400, { error: "Rolle muss Mitglied, Admin oder Gast sein" });

      const members = readMembers(teamId);
      if (members.length >= 200) return send(res, 400, { error: "zu viele Mitglieder" });

      const member = {
        id: `${slug(name)}-${crypto.randomBytes(2).toString("hex")}`,
        name,
        role,
        token: crypto.randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
      };
      members.push(member);
      try {
        writeMembers(teamId, members);
      } catch (writeError) {
        console.error("Mitglied speichern fehlgeschlagen:", writeError.message);
        return send(res, 500, { error: "Speichern fehlgeschlagen" });
      }
      return send(res, 200, { member });
    });
  }

  // GET /v1/teams/:id/members — Liste (Super sieht Tokens, Admin nicht)
  if (req.method === "GET" && rest === "/members") {
    if (who.role === "member") return send(res, 403, { error: "keine Berechtigung" });
    const members = readMembers(teamId).map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      createdAt: member.createdAt,
      ...(who.role === "super" ? { token: member.token } : {}),
    }));
    return send(res, 200, { members });
  }

  // GET /v1/teams/:id/members/:memberId/history?days=7 — Verlauf eines
  // Mitglieds. Wie die Meldungen für jede Rolle offen, sonst gäbe es in der
  // Detailansicht der Kollegen zwar Balken, aber keine Kurven.
  const historyMatch = rest.match(/^\/members\/([a-z0-9-]{1,64})\/history$/);
  if (req.method === "GET" && historyMatch) {
    const memberId = historyMatch[1];
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
    return send(res, 200, { memberId, days, samples: readHistory(teamId, memberId, days) });
  }

  // DELETE /v1/teams/:id/members/:memberId — Mitglied entfernen (nur Super-Admin)
  const memberMatch = rest.match(/^\/members\/([a-z0-9-]{1,64})$/);
  if (req.method === "PATCH" && memberMatch) {
    if (who.role !== "super") return send(res, 403, { error: "nur der Team-Inhaber darf Rollen ändern" });
    return readBody(req, (error, raw) => {
      if (error) return send(res, 413, { error: "zu groß" });
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "kein gültiges JSON" }); }
      if (!["member", "admin", "guest"].includes(body?.role)) return send(res, 400, { error: "Rolle muss Mitglied, Admin oder Gast sein" });
      let members;
      try { members = readMembers(teamId, true); } catch { return send(res, 500, { error: "Mitglieder konnten nicht gelesen werden" }); }
      const member = members.find((entry) => entry.id === memberMatch[1]);
      if (!member) return send(res, 404, { error: "Mitglied nicht gefunden" });
      if (member.enrollment && body.role !== "member") return send(res, 409, { error: "Registrierte Worker behalten die Mitgliedsrolle; für Gäste einen separaten Zugang anlegen" });
      member.role = body.role;
      try { writeMembers(teamId, members); } catch { return send(res, 500, { error: "Rolle konnte nicht gespeichert werden" }); }
      // Invalidate open dashboards immediately after a role change. Their next
      // GET re-evaluates which devices belong in the fleet, using the same token.
      for (const stream of fleetStreams.get(teamId) || []) {
        if (!stream.destroyed && !stream.writableEnded) stream.write("event: fleet\ndata: {}\n\n");
      }
      return send(res, 200, { member });
    });
  }
  if (req.method === "DELETE" && memberMatch) {
    if (who.role !== "super") return send(res, 403, { error: "nur der Team-Inhaber darf Mitglieder entfernen" });
    const members = readMembers(teamId);
    const remaining = members.filter((member) => member.id !== memberMatch[1]);
    if (remaining.length === members.length) return send(res, 404, { error: "Mitglied nicht gefunden" });
    try {
      writeMembers(teamId, remaining);
      // Meldung und Verlauf des Mitglieds gleich mit entfernen
      fs.rmSync(path.join(teamDir(teamId), "reports", `${memberMatch[1]}.json`), { force: true });
      fs.rmSync(historyPath(teamId, memberMatch[1]), { force: true });
    } catch (writeError) {
      console.error("Mitglied entfernen fehlgeschlagen:", writeError.message);
      return send(res, 500, { error: "Speichern fehlgeschlagen" });
    }
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "unbekannter Pfad" });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Team-Relay läuft auf Port ${server.address().port}, Ablage: ${DATA_DIR}`);
  });
}

module.exports = { server };
