// Team authentication issues short-lived SSH certificates, never a remote command.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { WORKER_ID } = require('./worker-control');
const execute = promisify(execFile);
const TEAM_ID = /^[A-Z0-9]{4,16}$/;
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/i;

class RemoteAccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function publicKey(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\x00]/.test(value)) throw new RemoteAccessError(400, 'Ungültiger öffentlicher SSH-Schlüssel');
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value.trim());
  if (!match) throw new RemoteAccessError(400, 'Ein einzelner Ed25519-Schlüssel ist erforderlich');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString() !== 'ssh-ed25519' ||
      bytes.readUInt32BE(15) !== 32 || bytes.toString('base64') !== match[1]) throw new RemoteAccessError(400, 'Ungültiger öffentlicher SSH-Schlüssel');
  return `ssh-ed25519 ${match[1]}`;
}

function loadAccess(dataDir, teamId) {
  if (!TEAM_ID.test(teamId)) throw new RemoteAccessError(400, 'Ungültiges Team');
  const directory = path.join(dataDir, teamId);
  const file = path.join(directory, 'remote-access.json');
  let value;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024 || stat.mode & 0o022) throw Error('unsafe');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw new RemoteAccessError(503, 'Team-Fernzugriff ist nicht eingerichtet'); }
  if (value.schema !== 1 || value.teamId !== teamId || value.enabled !== true ||
      typeof value.hubHost !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(value.hubHost) ||
      value.hubUser !== 'max-monitor-access' || !Array.isArray(value.workers) || !value.workers.length || value.workers.length > 200) {
    throw new RemoteAccessError(503, 'Ungültige Team-Fernzugriff-Konfiguration');
  }
  try {
    const workers = value.workers.map(v => {
      if (typeof v.workerId !== 'string' || !WORKER_ID.test(v.workerId) || typeof v.username !== 'string' || !USERNAME.test(v.username) ||
          !Number.isInteger(v.port) || v.port < 23000 || v.port > 23999) throw Error('invalid worker');
      return { workerId: v.workerId, username: v.username, port: v.port, hostKey: publicKey(v.hostKey) };
    });
    if (new Set(workers.map(v => v.workerId)).size !== workers.length || new Set(workers.map(v => v.port)).size !== workers.length) throw Error('duplicate');
    return { schema: 1, teamId, enabled: true, hubHost: value.hubHost, hubUser: value.hubUser,
      hubHostKey: publicKey(value.hubHostKey), workers, directory };
  } catch { throw new RemoteAccessError(503, 'Ungültige Team-Fernzugriff-Konfiguration'); }
}

function configuration(dataDir, teamId) {
  const { directory, ...result } = loadAccess(dataDir, teamId);
  return result;
}

const limits = new Map();
let activeSigners = 0;
function takeSlot(identity, now) {
  for (const [key, value] of limits) if (now - value.started >= 60_000) limits.delete(key);
  const value = limits.get(identity) || { started: now, count: 0 };
  if (value.count >= 30 || activeSigners >= 4 || limits.size >= 500 && !limits.has(identity)) throw new RemoteAccessError(429, 'Bitte kurz warten und die Verbindung erneut starten');
  value.count++; limits.set(identity, value);
}

async function issueCertificate(dataDir, teamId, memberId, body, { run = execute, now = Date.now() } = {}) {
  if (!/^[a-z0-9-]{1,64}$/.test(memberId || '') || !body || typeof body.workerId !== 'string' || !WORKER_ID.test(body.workerId)) {
    throw new RemoteAccessError(400, 'Ungültige Fernzugriffs-Anfrage');
  }
  const key = publicKey(body.publicKey);
  const settings = loadAccess(dataDir, teamId);
  const worker = settings.workers.find(v => v.workerId === body.workerId);
  if (!worker) throw new RemoteAccessError(404, 'Dieser Mac ist nicht für den Fernzugriff freigegeben');
  takeSlot(`${teamId}/${memberId}`, now);
  const ca = path.join(settings.directory, 'remote-ca');
  const stat = fs.lstatSync(ca);
  if (!stat.isFile() || stat.mode & 0o077) throw new RemoteAccessError(503, 'Team-Fernzugriff ist nicht eingerichtet');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-certificate-'));
  fs.chmodSync(temporary, 0o700);
  const keyFile = path.join(temporary, 'member.pub');
  const serial = crypto.randomBytes(6).readUIntBE(0, 6).toString();
  const identity = `${teamId}/${memberId}/${worker.workerId}`;
  activeSigners++;
  try {
    fs.writeFileSync(keyFile, key + '\n', { mode: 0o600, flag: 'wx' });
    await run('/usr/bin/ssh-keygen', ['-q', '-s', ca, '-I', identity, '-z', serial, '-n',
      `max-monitor-${teamId}-bastion,max-monitor-${teamId}-${worker.workerId}`, '-V', '-30s:+90s',
      '-O', 'clear', '-O', 'permit-pty', '-O', 'permit-port-forwarding', keyFile], { timeout: 5000, maxBuffer: 16 * 1024 });
    const certificate = fs.readFileSync(path.join(temporary, 'member-cert.pub'), 'utf8').trim();
    if (certificate.length > 16 * 1024 || !/^ssh-ed25519-cert-v01@openssh\.com [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(certificate)) throw Error('invalid certificate');
    const audit = path.join(settings.directory, 'remote-access-audit.jsonl');
    if (fs.existsSync(audit) && (!fs.lstatSync(audit).isFile() || fs.lstatSync(audit).size > 1024 * 1024)) {
      if (!fs.lstatSync(audit).isFile()) throw Error('invalid audit');
      fs.renameSync(audit, audit + '.previous');
    }
    fs.appendFileSync(audit, JSON.stringify({ at: new Date(now).toISOString(), memberId, workerId: worker.workerId, serial }) + '\n', { mode: 0o600 });
    return { schema: 1, teamId, memberId, worker, hubHost: settings.hubHost, hubUser: settings.hubUser,
      hubHostKey: settings.hubHostKey, certificate, expiresAt: new Date(now + 90_000).toISOString() };
  } finally {
    activeSigners--;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { RemoteAccessError, publicKey, loadAccess, configuration, issueCertificate };
