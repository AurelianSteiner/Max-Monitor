//
// Max Monitor — Team-Relay
//
// Winziger Dienst ohne Abhängigkeiten. Drei Rollen:
//   super   Team-Inhaber (Token aus TEAM_TOKENS): verwaltet Mitglieder,
//           sieht alles inklusive der Mitglieds-Tokens.
//   admin   sieht alle Meldungen des Teams, verwaltet aber nichts.
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

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";

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
  if (!expected || !candidate || candidate.length !== expected.length) return false;
  // Zeitkonstanter Vergleich, damit Tokens nicht über Antwortzeiten erratbar sind
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
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

function readMembers(teamId) {
  try {
    const raw = fs.readFileSync(path.join(teamDir(teamId), "members.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // fehlende oder kaputte Datei = keine Mitglieder, kein Absturz
  }
}

function writeMembers(teamId, members) {
  fs.mkdirSync(teamDir(teamId), { recursive: true });
  fs.writeFileSync(path.join(teamDir(teamId), "members.json"), JSON.stringify(members));
}

/// Wer ruft an? -> { role: "super"|"admin"|"member", member? } oder null
function identify(req, teamId) {
  const token = bearerToken(req);
  if (!token) return null;
  const id = String(teamId || "").toUpperCase();
  if (tokenMatches(token, superTokens.get(id)) || tokenMatches(token, superTokens.get(""))) {
    return { role: "super" };
  }
  for (const member of readMembers(id)) {
    if (tokenMatches(token, member.token)) {
      return { role: member.role === "admin" ? "admin" : "member", member };
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

function readBody(req, callback) {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      callback(new Error("zu groß"), null);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => callback(null, Buffer.concat(chunks).toString("utf8")));
  req.on("error", (error) => callback(error, null));
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

// ------------------------------------------------------------------ Server

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }

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
    return send(res, 200, { reports: readReports(teamId) });
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
      const role = body.role === "admin" ? "admin" : "member";

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

server.listen(PORT, () => {
  console.log(`Team-Relay läuft auf Port ${PORT}, Ablage: ${DATA_DIR}`);
});
