import { randomUUID } from 'node:crypto';
import { COLLECTIONS, isDuplicateKeyError } from '../db.js';
import { LIMITS, normalizeEmail, validateNewBooking } from '../validation.js';
import { getSlot } from './slots.js';
import * as idempotency from './idempotency.js';
import * as rateLimit from './rateLimit.js';

const ok = (status, body, headers) => (headers ? { status, body, headers } : { status, body });
const fail = (status, error, headers) => ok(status, { error }, headers);

export function toBookingJson(doc) {
  return {
    id: doc._id,
    slot_id: doc.slot_id,
    name: doc.name,
    email: doc.email,
    status: doc.status,
    created_at: doc.created_at.toISOString(),
  };
}

/**
 * Validates and inserts one booking. Double booking is blocked by the
 * one_confirmed_booking_per_slot unique index: the losing insert gets a duplicate key error -> 409.
 */
async function insertBooking(db, body, now) {
  const { error, value } = validateNewBooking(body);
  if (error) return fail(400, error);

  const slot = await getSlot(db, value.slot_id);
  if (!slot) return fail(404, 'slot not found');
  if (slot.start_at.getTime() <= now.getTime()) return fail(400, 'slot has already started');

  const doc = {
    _id: randomUUID(),
    slot_id: value.slot_id,
    name: value.name,
    email: value.email,
    status: 'confirmed',
    created_at: now,
  };
  try {
    await db.collection(COLLECTIONS.bookings).insertOne(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) return fail(409, 'slot already booked');
    throw err;
  }
  return ok(201, toBookingJson(doc));
}

/** The rate limit key: the normalized email, if the body carries one at all. */
function rateLimitKey(body) {
  const email = body && typeof body === 'object' ? body.email : undefined;
  if (typeof email !== 'string') return null;
  const key = normalizeEmail(email);
  return key === '' ? null : key;
}

/**
 * Full POST /bookings flow, shared by the JSON API and the web page:
 *   1. Idempotency-Key claim (level 4): replays and mismatches return before anything else.
 *   2. Rate limit per email (level 5): counted before validation, so failed attempts count too.
 *   3. Validation, slot checks and the insert (levels 1-3).
 * Returns { status, body, headers? }.
 */
export async function createBooking(db, { body, idempotencyKey, rateLimitConfig, now = () => new Date() }) {
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      return fail(400, 'Idempotency-Key must not be empty');
    }
    if (idempotencyKey.length > LIMITS.idempotencyKey) return fail(400, 'Idempotency-Key is too long');

    const claim = await idempotency.claim(db, idempotencyKey, idempotency.hashBody(body));
    if (claim.type === 'replay') return claim.response;
    if (claim.type === 'mismatch') return fail(422, 'Idempotency-Key was already used with a different request body');
    if (claim.type === 'in_progress') return fail(409, 'a request with this Idempotency-Key is still in progress');
  }

  let response;
  try {
    response = await attemptBooking(db, body, rateLimitConfig, now());
  } catch (err) {
    if (idempotencyKey !== undefined) await idempotency.release(db, idempotencyKey).catch(() => {});
    throw err;
  }

  if (idempotencyKey !== undefined) {
    // 429 is temporary, so it is not remembered: a retry after the wait should really run.
    if (response.status === 429) await idempotency.release(db, idempotencyKey);
    else await idempotency.complete(db, idempotencyKey, response);
  }
  return response;
}

async function attemptBooking(db, body, rateLimitConfig, now) {
  const key = rateLimitKey(body);
  if (key) {
    const verdict = await rateLimit.consume(db, key, rateLimitConfig, now);
    if (!verdict.allowed) {
      return fail(429, 'too many booking attempts for this email, try again later', {
        'Retry-After': String(verdict.retryAfter),
      });
    }
  }
  return insertBooking(db, body, now);
}

export async function getBooking(db, id) {
  const doc = await db.collection(COLLECTIONS.bookings).findOne({ _id: id });
  return doc ? toBookingJson(doc) : null;
}

/** Sets status to cancelled (frees the slot). Atomic, so two cancels can't both succeed. */
export async function cancelBooking(db, id) {
  const doc = await db
    .collection(COLLECTIONS.bookings)
    .findOneAndUpdate({ _id: id, status: 'confirmed' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' });
  if (doc) return ok(200, toBookingJson(doc));

  const exists = await db.collection(COLLECTIONS.bookings).findOne({ _id: id }, { projection: { _id: 1 } });
  return exists ? fail(409, 'booking already cancelled') : fail(404, 'booking not found');
}

/* ---------- Listing a person's bookings with cursor pagination (level 4) ---------- */

export function encodeCursor(doc) {
  return Buffer.from(JSON.stringify({ t: doc.created_at.getTime(), id: doc._id })).toString('base64url');
}

export function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isFinite(t) || typeof id !== 'string') return null;
    return { t: new Date(t), id };
  } catch {
    return null;
  }
}

/** Oldest first, ordered by (created_at, _id) so ties at the same millisecond page stably. */
export async function listBookingsByEmail(db, { email, limit, cursor }) {
  const filter = { email: normalizeEmail(email) };
  if (cursor) {
    filter.$or = [{ created_at: { $gt: cursor.t } }, { created_at: cursor.t, _id: { $gt: cursor.id } }];
  }
  const docs = await db
    .collection(COLLECTIONS.bookings)
    .find(filter)
    .sort({ created_at: 1, _id: 1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  return {
    bookings: page.map(toBookingJson),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}
