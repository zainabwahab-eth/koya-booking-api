#!/usr/bin/env node
/**
 * Black-box contract check against a running deployment, level by level, the way an
 * external grader would see it. Uses only HTTP.
 *
 *   npm run check -- https://your-service.run.app
 *   BASE_URL=http://localhost:3000 npm run check
 *
 * Needs API_KEY (read from .env by `npm run check`).
 * WARNING: calls POST /reset, which deletes every booking and replaces all slots.
 * Run `npm run seed` afterwards if you want demo slots back on the web page.
 */
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY;
if (!KEY) {
  console.error('API_KEY is not set');
  process.exit(2);
}

const run = randomUUID().slice(0, 8);
const email = (tag) => `check-${tag}-${run}@example.com`;
const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace('.000Z', 'Z');

async function call(method, path, { body, headers = {}, key = KEY } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, headers: res.headers };
}

const results = [];
async function check(level, name, fn) {
  try {
    await fn();
    results.push({ level, name, ok: true });
    console.log(`  PASS  L${level}  ${name}`);
  } catch (err) {
    results.push({ level, name, ok: false, err: err.message });
    console.log(`  FAIL  L${level}  ${name}\n          ${err.message}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const expectStatus = (res, want) =>
  expect(res.status === want, `expected ${want}, got ${res.status} ${JSON.stringify(res.body)}`);
const expectErrorShape = (res) =>
  expect(res.body && typeof res.body.error === 'string' && Object.keys(res.body).length === 1, `bad error shape: ${JSON.stringify(res.body)}`);

const slots = [
  { id: 'c3', provider: 'Dr Ade', start: hours(50), end: hours(50.5) },
  { id: 'c1', provider: 'Dr Ade', start: hours(48), end: hours(48.5) },
  { id: 'c2', provider: 'Dr Bello', start: hours(49), end: hours(49.5) },
  { id: 'cpast', provider: 'Dr Ade', start: hours(-3), end: hours(-2.5) },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `cp${i}`, provider: 'Dr Page', start: hours(60 + i), end: hours(60.5 + i) })),
];

console.log(`Contract check against ${BASE}\n`);
const t0 = Date.now();

await check(1, 'POST /reset returns 200', async () => expectStatus(await call('POST', '/reset', { body: { slots } }), 200));

await check(1, 'GET /slots: all slots, earliest first, with available', async () => {
  const r = await call('GET', '/slots');
  expectStatus(r, 200);
  const ids = r.body.slots.map((s) => s.id);
  expect(ids.join() === ['cpast', 'c1', 'c2', 'c3', ...slots.slice(4).map((s) => s.id)].join(), `order: ${ids}`);
  expect(r.body.slots.every((s) => s.available === true), 'all should be available');
  expect(r.body.slots[1].start === slots[1].start, 'start should echo exactly');
});

await check(1, 'GET /slots?provider= exact match', async () => {
  const r = await call('GET', `/slots?provider=${encodeURIComponent('Dr Bello')}`);
  expect(r.body.slots.length === 1 && r.body.slots[0].id === 'c2', JSON.stringify(r.body));
});

let booking;
await check(1, 'POST /bookings returns 201 confirmed', async () => {
  const r = await call('POST', '/bookings', { body: { slot_id: 'c1', name: 'Ada Obi', email: email('l1') } });
  expectStatus(r, 201);
  booking = r.body;
  for (const k of ['id', 'slot_id', 'name', 'email', 'status', 'created_at']) expect(k in r.body, `missing ${k}`);
  expect(r.body.status === 'confirmed', 'status should be confirmed');
});

await check(1, 'GET /bookings/:id finds it; unknown is 404', async () => {
  const r = await call('GET', `/bookings/${booking.id}`);
  expectStatus(r, 200);
  expect(r.body.id === booking.id, 'id mismatch');
  const m = await call('GET', '/bookings/does-not-exist');
  expectStatus(m, 404);
  expectErrorShape(m);
});

await check(1, 'booked slot shows available: false', async () => {
  const r = await call('GET', '/slots');
  expect(r.body.slots.find((s) => s.id === 'c1').available === false, 'c1 should be unavailable');
});

await check(2, 'missing and wrong API key are 401', async () => {
  for (const key of [null, 'wrong-key']) {
    for (const [m, p] of [['GET', '/slots'], ['POST', '/bookings'], ['GET', `/bookings/${booking.id}`], ['POST', '/reset']]) {
      const r = await call(m, p, { key, body: m === 'POST' ? {} : undefined });
      expect(r.status === 401, `${m} ${p} key=${key} got ${r.status}`);
    }
  }
});

await check(2, 'missing / empty / invalid fields are 400', async () => {
  const cases = [
    { name: 'A', email: email('v1') },
    { slot_id: '', name: 'A', email: email('v2') },
    { slot_id: 'c2', email: email('v3') },
    { slot_id: 'c2', name: '  ', email: email('v4') },
    { slot_id: 'c2', name: 'A' },
    { slot_id: 'c2', name: 'A', email: 'not-an-email' },
  ];
  for (const body of cases) {
    const r = await call('POST', '/bookings', { body });
    expect(r.status === 400, `${JSON.stringify(body)} got ${r.status}`);
    expectErrorShape(r);
  }
});

await check(2, 'unknown slot 404, started slot 400', async () => {
  expectStatus(await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'A', email: email('v5') } }), 404);
  expectStatus(await call('POST', '/bookings', { body: { slot_id: 'cpast', name: 'A', email: email('v6') } }), 400);
});

await check(2, 'name/email trimmed, email lower-cased', async () => {
  const e = email('trim');
  const r = await call('POST', '/bookings', { body: { slot_id: 'c2', name: '  Ada  ', email: `  ${e.toUpperCase()} ` } });
  expectStatus(r, 201);
  expect(r.body.name === 'Ada' && r.body.email === e, JSON.stringify(r.body));
  await call('DELETE', `/bookings/${r.body.id}`);
});

await check(3, '20 simultaneous bookings for one slot: exactly one 201', async () => {
  const rs = await Promise.all(
    Array.from({ length: 20 }, (_, i) => call('POST', '/bookings', { body: { slot_id: 'c3', name: 'R', email: email(`race${i}`) } })),
  );
  const s = rs.map((r) => r.status);
  expect(s.filter((x) => x === 201).length === 1 && s.filter((x) => x === 409).length === 19, `statuses: ${s}`);
});

await check(3, 'cancel: 200 cancelled, frees slot, second cancel 409', async () => {
  const c = await call('DELETE', `/bookings/${booking.id}`);
  expectStatus(c, 200);
  expect(c.body.status === 'cancelled', 'status should be cancelled');
  const again = await call('DELETE', `/bookings/${booking.id}`);
  expectStatus(again, 409);
  expectStatus(await call('DELETE', '/bookings/nope'), 404);
  const rebook = await call('POST', '/bookings', { body: { slot_id: 'c1', name: 'B', email: email('rebook') } });
  expectStatus(rebook, 201);
});

await check(4, 'Idempotency-Key: same body replays, different body 422', async () => {
  const k = `idem-${run}`;
  const body = { slot_id: 'c2', name: 'Ada', email: email('idem') };
  const a = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': k } });
  const b = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': k } });
  expectStatus(a, 201);
  expect(b.status === 201 && b.body.id === a.body.id, `replay: ${b.status} ${b.body?.id} vs ${a.body.id}`);
  const c = await call('POST', '/bookings', { body: { ...body, slot_id: 'cp0' }, headers: { 'Idempotency-Key': k } });
  expectStatus(c, 422);
});

await check(4, 'Idempotency-Key: 10 simultaneous retries -> one booking', async () => {
  const k = `idem-burst-${run}`;
  const body = { slot_id: 'cp7', name: 'Ada', email: email('burst') };
  const rs = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/bookings', { body, headers: { 'Idempotency-Key': k } })));
  expect(rs.every((r) => r.status === 201), `statuses: ${rs.map((r) => r.status)}`);
  expect(new Set(rs.map((r) => r.body.id)).size === 1, 'ids differ');
});

await check(4, 'GET /bookings pages oldest first with next_cursor', async () => {
  const e = email('pager');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: `cp${i + 1}`, name: 'P', email: e } });
    expectStatus(r, 201);
    ids.push(r.body.id);
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(e.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await call('GET', q);
    expectStatus(r, 200);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  expect(pages === 3 && seen.join() === ids.join(), `pages=${pages} seen=${seen.length}`);
  expect(cursor === null, 'last page next_cursor should be null');
});

await check(4, 'GET /bookings bad limit is 400', async () => {
  for (const l of ['0', '51', 'abc']) {
    expectStatus(await call('GET', `/bookings?email=${encodeURIComponent(email('x'))}&limit=${l}`), 400);
  }
});

await check(5, '6th attempt per email in a minute is 429 with Retry-After; others unaffected', async () => {
  const e = email('spam');
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'S', email: e } });
    expect(r.status === 404, `attempt ${i + 1} got ${r.status}`);
  }
  const sixth = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'S', email: e } });
  expectStatus(sixth, 429);
  const ra = sixth.headers.get('retry-after');
  expect(/^\d+$/.test(ra || '') && Number(ra) >= 1 && Number(ra) <= 60, `Retry-After: ${ra}`);
  const other = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'S', email: email('innocent') } });
  expectStatus(other, 404);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed.length ? 1 : 0);
