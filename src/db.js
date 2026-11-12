import dns from 'node:dns';
import { MongoClient } from 'mongodb';

/**
 * "8.8.8.8, 1.1.1.1" -> ['8.8.8.8', '1.1.1.1']. Empty or unset -> [].
 * Used to override Node's DNS resolvers when the system one can't answer SRV lookups
 * (needed for mongodb+srv:// URLs; some Windows setups point Node at a local 127.0.0.1 resolver).
 */
export function parseDnsServers(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function applyDnsServers(value = process.env.DNS_SERVERS) {
  const servers = parseDnsServers(value);
  if (servers.length > 0) dns.setServers(servers);
  return servers;
}

export const COLLECTIONS = {
  slots: 'slots',
  bookings: 'bookings',
  idempotencyKeys: 'idempotency_keys',
  rateLimits: 'rate_limits',
};

export async function connect(uri, dbName) {
  if (!uri) throw new Error('DATABASE_URL is not set');
  applyDnsServers();
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
