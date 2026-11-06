import { randomUUID } from 'node:crypto';
import { COLLECTIONS, isDuplicateKeyError } from '../db.js';

export const DEFAULT_RATE_LIMIT = { max: 5, windowMs: 60_000 };

/**
 * Sliding-window limiter stored in MongoDB, keyed by normalized email (level 5).
 *
 * One document per email holds the timestamps of allowed attempts in the last window.
 * The check-and-record is a single atomic findOneAndUpdate with a pipeline, so concurrent
 * requests for the same email can never let more than `max` through. State lives in the
 * database, so it holds across restarts and across multiple instances.
 *
 * Returns { allowed: true } or { allowed: false, retryAfter } (whole seconds, >= 1).
 */
export async function consume(db, key, { max, windowMs } = DEFAULT_RATE_LIMIT, now = new Date()) {
  const col = db.collection(COLLECTIONS.rateLimits);
  const token = randomUUID();
  const cutoff = new Date(now.getTime() - windowMs);

  const pipeline = [
    {
      $set: {
        hits: {
          $filter: { input: { $ifNull: ['$hits', []] }, cond: { $gt: ['$$this', cutoff] } },
        },
      },
    },
    { $set: { _allowed: { $lt: [{ $size: '$hits' }, max] } } },
    {
      $set: {
        hits: { $cond: ['$_allowed', { $concatArrays: ['$hits', [now]] }, '$hits'] },
        token: { $cond: ['$_allowed', { $literal: token }, '$token'] },
        expires_at: new Date(now.getTime() + windowMs),
      },
    },
    { $unset: '_allowed' },
  ];

  let doc;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      doc = await col.findOneAndUpdate({ _id: key }, pipeline, { upsert: true, returnDocument: 'after' });
      break;
    } catch (err) {
      // Two first-ever requests for the same email can race on the upsert; the loser retries.
      if (!isDuplicateKeyError(err) || attempt === 2) throw err;
    }
  }

  if (doc.token === token) return { allowed: true };

  const oldest = Math.min(...doc.hits.map((d) => new Date(d).getTime()));
  const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now.getTime()) / 1000));
  return { allowed: false, retryAfter };
}
