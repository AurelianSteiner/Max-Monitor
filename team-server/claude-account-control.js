// Admission preferences, separate from worker observations and credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WORKER_ID, DEVICE_ID } = require('./worker-control');
const ACCOUNT_IDS = ['primary', 'account-2'];

function read(dir) {
  try {
    const file = path.join(dir, 'claude-account-control.json');
    if (fs.statSync(file).size > 128 * 1024) throw Error('size');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schema !== 1 || !Array.isArray(value.workers) || value.workers.length > 200
      || value.workers.some(w => !WORKER_ID.test(w?.workerId) || !DEVICE_ID.test(w.deviceId)
        || !validIds(w.disabledAccountIds)) || new Set(value.workers.map(w => w.workerId)).size !== value.workers.length) throw Error('schema');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, workers: [] };
    throw Error('Claude-Account-Sperren konnten nicht gelesen werden.');
  }
}
function validIds(ids) {
  return Array.isArray(ids) && ids.length <= 2 && new Set(ids).size === ids.length && ids.every(id => ACCOUNT_IDS.includes(id));
}
function control(dir, workerId, deviceId) {
  const entry = read(dir).workers.find(w => w.workerId === workerId && w.deviceId === deviceId);
  return { disabledAccountIds: entry?.disabledAccountIds || [] };
}
function save(dir, { workerId, deviceId, accountId, disabled }) {
  if (!WORKER_ID.test(workerId) || !DEVICE_ID.test(deviceId) || !ACCOUNT_IDS.includes(accountId) || typeof disabled !== 'boolean')
    throw Error('Ungültige Claude-Account-Sperre.');
  const value = read(dir), previous = control(dir, workerId, deviceId).disabledAccountIds;
  const disabledAccountIds = ACCOUNT_IDS.filter(id => id === accountId ? disabled : previous.includes(id));
  value.workers = value.workers.filter(w => w.workerId !== workerId);
  if (disabledAccountIds.length) value.workers.push({ workerId, deviceId, disabledAccountIds });
  const file = path.join(dir, 'claude-account-control.json'), tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  return { disabledAccountIds };
}
module.exports = { control, save, validIds };
