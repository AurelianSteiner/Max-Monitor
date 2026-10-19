import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function bridgeTokenFile(directory) { return path.join(directory, 'bridge-token'); }

// Called by installation only. Scheduled runs read the private file directly.
export function prepareBridgeToken(directory, { importLegacy = false, readLegacy = teamId =>
  execFileSync('/usr/bin/security', ['find-generic-password', '-w', '-s', 'MaxMonitor Newsletter Bridge', '-a', teamId],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), teamId } = {}) {
  if (importLegacy) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const file = bridgeTokenFile(directory);
  const validate = value => {
    const token = String(value).trim();
    if (!token || /[\s\0]/.test(token)) throw new Error('Gespeicherter Monitor-Token ist leer oder ungültig.');
    return token;
  };
  const existing = () => {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid()) throw new Error('Monitor-Token ist keine eigene reguläre Datei.');
    validate(fs.readFileSync(file, 'utf8'));
    if (importLegacy) fs.chmodSync(file, 0o600);
    else if ((info.mode & 0o777) !== 0o600 || (fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw new Error('Monitor-Token benötigt private Dateirechte. Installer erneut ausführen.');
    }
    return file;
  };
  try { return existing(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!importLegacy) throw new Error('Lokaler Monitor-Token fehlt. Installer einmal zur Übernahme aus dem Schlüsselbund ausführen.');
  let token;
  try { token = validate(readLegacy(teamId)); }
  catch { throw new Error('Monitor-Token konnte nicht übernommen werden. Schlüsselbundzugriff bei der Einrichtung erlauben.'); }
  const temporary = path.join(directory, `.bridge-token-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, token, { flag: 'wx', mode: 0o600, flush: true });
    // Publish a complete file without replacing a concurrently completed setup.
    try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return existing();
}
