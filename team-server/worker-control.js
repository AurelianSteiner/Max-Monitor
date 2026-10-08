// Resolve the current reporting identity, including disabled and reassigned Macs.
// Display names and queue-source observations are never identity bindings.
const WORKER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function controlForWorker(workerId, members, machines, deviceId = null) {
  if (!WORKER_ID.test(workerId)) throw new Error("Ungültige Worker-ID");
  if (deviceId !== null && !DEVICE_ID.test(deviceId)) throw new Error("Ungültige Geräte-ID");
  const bound = machines.filter(machine => machine.workerId === workerId && machine.telemetrySource !== "worker");
  const device = deviceId && machines.find(machine => machine.deviceId === deviceId && machine.telemetrySource !== "worker");
  if ((deviceId && bound.length && bound.some(machine => machine.deviceId !== deviceId)) ||
      (device?.workerId && device.workerId !== workerId)) return { schema: 1, workerId, enabled: false, reason: 'ambiguous' };
  // Older manually connected app installations may not have a Worker ID yet.
  // Their existing random app UUID still provides an exact device binding.
  const native = bound.length ? bound : device ? [device] : [];
  const enrolled = members.filter(member => member.enrollment?.workerId === workerId);
  if (!native.length && deviceId && enrolled.some(member => member.enrollment.deviceId !== deviceId)) {
    return { schema: 1, workerId, enabled: false, reason: 'ambiguous' };
  }
  const ids = native.length
    ? new Set(native.map(machine => machine.memberId === null ? 'team-owner' : machine.memberId))
    : new Set(enrolled.map(member => member.id));
  const identity = ids.size === 1 ? members.find(member => ids.has(member.id)) : null;
  const enabled = Boolean(identity && (typeof identity.macWorker === "boolean" ? identity.macWorker : identity.role === "member"));
  return { schema: 1, workerId, enabled,
    reason: ids.size > 1 ? "ambiguous" : !identity ? "unregistered" : enabled ? "enabled" : "disabled" };
}

module.exports = { controlForWorker, WORKER_ID, DEVICE_ID };
