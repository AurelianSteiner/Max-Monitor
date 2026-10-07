const crypto = require("node:crypto");

const WORKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class EnrollmentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateEnrollment(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new EnrollmentError(400, "Registrierung muss ein Objekt sein");
  if (typeof body.workerId !== "string" || !WORKER_PATTERN.test(body.workerId)) throw new EnrollmentError(400, "workerId fehlt oder ist ungültig");
  if (typeof body.deviceId !== "string" || !UUID_PATTERN.test(body.deviceId)) throw new EnrollmentError(400, "deviceId muss die stabile UUID der Monitor-App sein");
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120 || /[\x00-\x1f\x7f]/.test(body.name))) {
    throw new EnrollmentError(400, "name ist ungültig");
  }
  return { workerId: body.workerId, deviceId: body.deviceId.toLowerCase(), name: body.name?.trim() || body.workerId };
}

// Storage operations must stay synchronous and the relay must have one writer.
// Retrying the same Mac returns the same member; a copied identity fails closed.
function enrollWorkerMember(body, { read, write }) {
  const enrollment = validateEnrollment(body);
  const members = read();
  const existing = members.find((member) => member.enrollment?.workerId === enrollment.workerId);
  if (existing) {
    if (existing.enrollment.deviceId !== enrollment.deviceId) throw new EnrollmentError(409, "Worker-ID ist bereits einem anderen Mac zugeordnet");
    if (existing.role !== "member" || typeof existing.token !== "string" || !/^[0-9a-f]{32}$/.test(existing.token)) throw new EnrollmentError(409, "registriertes Worker-Mitglied muss vom Inhaber geprüft werden");
    return { member: existing, created: false };
  }
  if (members.some((member) => member.enrollment?.deviceId === enrollment.deviceId)) throw new EnrollmentError(409, "Mac ist bereits mit einer anderen Worker-ID registriert");
  if (members.length >= 200) throw new EnrollmentError(400, "zu viele Mitglieder");
  const member = {
    id: `worker-${crypto.createHash("sha256").update(enrollment.workerId).digest("hex").slice(0, 24)}`,
    name: enrollment.name,
    role: "member",
    token: crypto.randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
    enrollment: { workerId: enrollment.workerId, deviceId: enrollment.deviceId },
  };
  if (members.some((item) => item.id === member.id)) throw new EnrollmentError(409, "Worker-Mitglieds-ID ist bereits vergeben");
  write([...members, member]);
  return { member, created: true };
}

module.exports = { EnrollmentError, validateEnrollment, enrollWorkerMember };
