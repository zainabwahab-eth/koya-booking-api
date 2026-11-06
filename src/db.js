import { MongoClient } from 'mongodb';

export const COLLECTIONS = {
  slots: 'slots',
  bookings: 'bookings',
  idempotencyKeys: 'idempotency_keys',
  rateLimits: 'rate_limits',
};

export async function connect(uri, dbName) {
  if (!uri) throw new Error('DATABASE_URL is not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(dbName);
  await ensureIndexes(db);
  return { client, db };
}

/**
 * Indexes carry real rules, not just speed:
 * - one_confirmed_booking_per_slot is what makes double booking impossible (level 3).
 *   MongoDB enforces it atomically, so two simultaneous inserts cannot both win.
 * - TTL indexes clean up idempotency records and rate limit windows on their own.
 */
export async function ensureIndexes(db) {
  await db.collection(COLLECTIONS.bookings).createIndexes([
    {
      key: { slot_id: 1 },
      name: 'one_confirmed_booking_per_slot',
      unique: true,
      partialFilterExpression: { status: 'confirmed' },
    },
    { key: { email: 1, created_at: 1, _id: 1 }, name: 'bookings_by_email' },
  ]);
  await db.collection(COLLECTIONS.slots).createIndex({ start_at: 1, _id: 1 }, { name: 'slots_by_start' });
  await db
    .collection(COLLECTIONS.idempotencyKeys)
    .createIndex({ expires_at: 1 }, { name: 'idempotency_ttl', expireAfterSeconds: 0 });
  await db
    .collection(COLLECTIONS.rateLimits)
    .createIndex({ expires_at: 1 }, { name: 'rate_limit_ttl', expireAfterSeconds: 0 });
}

export function isDuplicateKeyError(err) {
  return err && err.code === 11000;
}
