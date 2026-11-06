import { after, before, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createApp } from '../app.js';
import { ensureIndexes } from '../src/db.js';

export const API_KEY = 'test-key-123';

const HOUR = 60 * 60 * 1000;
export const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
export const future = (hours) => iso(Date.now() + hours * HOUR);

/** Default test slots: s1..s3 in the future, past1 already started. */
export function sampleSlots() {
  return [
    { id: 's2', provider: 'Dr Bello', start: future(26), end: future(26.5) },
    { id: 's1', provider: 'Dr Ade', start: future(25), end: future(25.5) },
    { id: 's3', provider: 'Dr Ade', start: future(27), end: future(27.5) },
    { id: 'past1', provider: 'Dr Ade', start: iso(Date.now() - 2 * HOUR), end: iso(Date.now() - HOUR) },
  ];
}

/**
 * Spins up an isolated in-memory MongoDB + app per test file and resets data before each test.
 * Returns a context whose fields are filled in by the `before` hook.
 */
export function setupTestApp({ rateLimitConfig } = {}) {
  const ctx = {};
  let mongod;
  let client;

  before(async () => {
    let uri = process.env.TEST_MONGO_URI;
    if (!uri) {
      // running a single file without the global setup
      mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
      uri = mongod.getUri();
    }
    client = new MongoClient(uri);
    await client.connect();
    ctx.db = client.db(`test_${randomUUID().replaceAll('-', '')}`);
    await ensureIndexes(ctx.db);
    const app = createApp({ db: ctx.db, apiKey: API_KEY, rateLimitConfig });
    ctx.server = app.listen(0);
    ctx.http = () => request(ctx.server);
    ctx.api = {
      get: (p) => request(ctx.server).get(p).set('X-API-Key', API_KEY),
      post: (p) => request(ctx.server).post(p).set('X-API-Key', API_KEY),
      delete: (p) => request(ctx.server).delete(p).set('X-API-Key', API_KEY),
    };
    ctx.reset = (slots = sampleSlots()) => ctx.api.post('/reset').send({ slots });
    ctx.book = (body, headers = {}) => ctx.api.post('/bookings').set(headers).send(body);
  });

  beforeEach(async () => {
    const res = await ctx.reset();
    if (res.status !== 200) throw new Error(`reset failed: ${res.status}`);
  });

  after(async () => {
    if (ctx.server) await new Promise((r) => ctx.server.close(r));
    if (ctx.db) await ctx.db.dropDatabase().catch(() => {});
    await client?.close();
    await mongod?.stop();
  });

  return ctx;
}

let counter = 0;
/** A fresh email per call so the per-email rate limit never leaks between assertions. */
export const uniqueEmail = (prefix = 'user') => `${prefix}${Date.now()}${counter++}@example.com`;
