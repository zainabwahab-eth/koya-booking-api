import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { COLLECTIONS, isDuplicateKeyError } from '../db.js';

const RETENTION_MS = 24 * 60 * 60 * 1000; // keys are remembered for 24h
const STALE_PENDING_MS = 30_000; // a pending claim older than this is treated as abandoned
const WAIT_MS = 10_000; // how long a concurrent duplicate waits for the first request to finish
const POLL_MS = 25;

/** JSON with object keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashBody(body) {
  return createHash('sha256').update(stableStringify(body ?? null)).digest('hex');
}

/**
 * Claims an Idempotency-Key (level 4). Possible results:
 *  { type: 'new' }                 caller owns the key and must call complete() or release()
 *  { type: 'replay', response }    same key + same body already finished: return the stored response
 *  { type: 'mismatch' }            same key, different body: 422
 *  { type: 'in_progress' }         same key still running after waiting WAIT_MS
 *
 * The claim is an insert on _id = key, so only one request can own a key, even when
 * duplicates arrive at the same moment. The others wait for the owner's stored response.
 */
export async function claim(db, key, bodyHash) {
  const col = db.collection(COLLECTIONS.idempotencyKeys);
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    const now = new Date();
    try {
      await col.insertOne({
        _id: key,
        hash: bodyHash,
        state: 'pending',
        locked_at: now,
        expires_at: new Date(now.getTime() + RETENTION_MS),
      });
      return { type: 'new' };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }

    const existing = await col.findOne({ _id: key });
    if (!existing) continue; // released between our insert and read: try again
    if (existing.hash !== bodyHash) return { type: 'mismatch' };
    if (existing.state === 'done') return { type: 'replay', response: existing.response };

    if (now.getTime() - existing.locked_at.getTime() > STALE_PENDING_MS) {
      await col.deleteOne({ _id: key, state: 'pending', locked_at: existing.locked_at });
      continue;
    }
    if (Date.now() > deadline) return { type: 'in_progress' };
    await sleep(POLL_MS);
  }
}

export async function complete(db, key, response) {
  await db
    .collection(COLLECTIONS.idempotencyKeys)
    .updateOne(
      { _id: key },
      { $set: { state: 'done', response: { status: response.status, body: response.body } } },
    );
}

export async function release(db, key) {
  await db.collection(COLLECTIONS.idempotencyKeys).deleteOne({ _id: key, state: 'pending' });
}
