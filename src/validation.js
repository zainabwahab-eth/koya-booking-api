// Pragmatic email check: something@something.tld, no spaces, one @.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LIMITS = { name: 200, email: 254, slotId: 200, idempotencyKey: 255 };

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= LIMITS.email && EMAIL_RE.test(email);
}

export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * Validates a POST /bookings body.
 * Returns { error } or { value: { slot_id, name, email } } with name/email trimmed and email lower-cased.
 */
export function validateNewBooking(body) {
  if (!isPlainObject(body)) return { error: 'request body must be a JSON object' };
  const { slot_id, name, email } = body;

  if (slot_id === undefined || slot_id === null || slot_id === '') return { error: 'slot_id is required' };
  if (typeof slot_id !== 'string') return { error: 'slot_id must be a string' };
  if (slot_id.trim() === '') return { error: 'slot_id is required' };
  if (slot_id.length > LIMITS.slotId) return { error: 'slot_id is too long' };

  if (name === undefined || name === null) return { error: 'name is required' };
  if (typeof name !== 'string') return { error: 'name must be a string' };
  const cleanName = name.trim();
  if (cleanName === '') return { error: 'name is required' };
  if (cleanName.length > LIMITS.name) return { error: `name must be at most ${LIMITS.name} characters` };

  if (email === undefined || email === null) return { error: 'email is required' };
  if (typeof email !== 'string') return { error: 'email must be a string' };
  const cleanEmail = normalizeEmail(email);
  if (cleanEmail === '') return { error: 'email is required' };
  if (!isValidEmail(cleanEmail)) return { error: 'email is not valid' };

  return { value: { slot_id, name: cleanName, email: cleanEmail } };
}

/** Validates the POST /reset body. Returns { error } or { value: slots[] }. */
export function validateResetBody(body) {
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    return { error: 'slots must be an array' };
  }
  const seen = new Set();
  const slots = [];
  for (const [i, slot] of body.slots.entries()) {
    if (!isPlainObject(slot)) return { error: `slots[${i}] must be an object` };
    const { id, provider, start, end } = slot;
    if (typeof id !== 'string' || id.trim() === '') return { error: `slots[${i}].id is required` };
    if (typeof provider !== 'string' || provider.trim() === '') return { error: `slots[${i}].provider is required` };
    if (typeof start !== 'string' || Number.isNaN(Date.parse(start))) {
      return { error: `slots[${i}].start must be a date-time string` };
    }
    if (typeof end !== 'string' || Number.isNaN(Date.parse(end))) {
      return { error: `slots[${i}].end must be a date-time string` };
    }
    if (seen.has(id)) return { error: `duplicate slot id: ${id}` };
    seen.add(id);
    slots.push({ id, provider, start, end });
  }
  return { value: slots };
}

/** Parses the `limit` query param for GET /bookings: integer 1..50, default 10. */
export function parseLimit(raw) {
  if (raw === undefined) return { value: 10 };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { error: 'limit must be an integer from 1 to 50' };
  const n = Number(raw);
  if (n < 1 || n > 50) return { error: 'limit must be an integer from 1 to 50' };
  return { value: n };
}
