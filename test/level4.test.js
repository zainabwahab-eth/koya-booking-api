import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uniqueEmail, future } from './helpers.js';

// Paging tests create many bookings for one email, so raise the rate limit for this file only.
const ctx = setupTestApp({ rateLimitConfig: { max: 1000, windowMs: 60_000 } });

describe('Level 4: idempotency', () => {
  it('same key + same body returns the same response and creates one booking', async () => {
    const body = { slot_id: 's1', name: 'Ada', email: uniqueEmail() };
    const first = await ctx.book(body, { 'Idempotency-Key': 'k-1' });
    const second = await ctx.book(body, { 'Idempotency-Key': 'k-1' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);
    assert.equal(await ctx.db.collection('bookings').countDocuments({}), 1);
  });

  it('body key order does not matter for "same body"', async () => {
    const email = uniqueEmail();
    const first = await ctx.book({ slot_id: 's1', name: 'Ada', email }, { 'Idempotency-Key': 'k-order' });
    const second = await ctx.book({ email, name: 'Ada', slot_id: 's1' }, { 'Idempotency-Key': 'k-order' });
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id);
  });

  it('same key + different body is 422', async () => {
    const email = uniqueEmail();
    await ctx.book({ slot_id: 's1', name: 'Ada', email }, { 'Idempotency-Key': 'k-2' });
    const res = await ctx.book({ slot_id: 's2', name: 'Ada', email }, { 'Idempotency-Key': 'k-2' });
    assert.equal(res.status, 422);
    assert.equal(typeof res.body.error, 'string');
  });

  it('a replay of a failed request returns the same failure status', async () => {
    const body = { slot_id: 'nope', name: 'Ada', email: uniqueEmail() };
    const first = await ctx.book(body, { 'Idempotency-Key': 'k-404' });
    const second = await ctx.book(body, { 'Idempotency-Key': 'k-404' });
    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
  });

  it('20 simultaneous retries with one key create exactly one booking, all with the same id', async () => {
    const body = { slot_id: 's3', name: 'Ada', email: uniqueEmail() };
    const results = await Promise.all(Array.from({ length: 20 }, () => ctx.book(body, { 'Idempotency-Key': 'k-burst' })));
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201]);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(await ctx.db.collection('bookings').countDocuments({}), 1);
  });

  it('without a key, two identical requests are two attempts (second is 409 for the same slot)', async () => {
    const body = { slot_id: 's1', name: 'Ada', email: uniqueEmail() };
    assert.equal((await ctx.book(body)).status, 201);
    assert.equal((await ctx.book(body)).status, 409);
  });

  it('different keys are independent', async () => {
    const a = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() }, { 'Idempotency-Key': 'k-a' });
    const b = await ctx.book({ slot_id: 's2', name: 'Ada', email: uniqueEmail() }, { 'Idempotency-Key': 'k-b' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
  });
});

describe('Level 4: paging through a person\'s bookings', () => {
  async function makeBookings(email, n) {
    const slots = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      provider: 'Dr Page',
      start: future(30 + i),
      end: future(30.5 + i),
    }));
    await ctx.reset(slots);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const res = await ctx.book({ slot_id: `p${i}`, name: 'Ada', email });
      assert.equal(res.status, 201);
      ids.push(res.body.id);
    }
    return ids;
  }

  it('pages oldest first with next_cursor, last page has next_cursor null', async () => {
    const email = uniqueEmail('pager');
    const ids = await makeBookings(email, 7);
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const q = { email, limit: 3 };
      if (cursor) q.cursor = cursor;
      const res = await ctx.api.get('/bookings').query(q);
      assert.equal(res.status, 200);
      assert.ok(res.body.bookings.length <= 3);
      seen.push(...res.body.bookings.map((b) => b.id));
      cursor = res.body.next_cursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ids);
  });

  it('exact multiple of limit: last page is full and has next_cursor null', async () => {
    const email = uniqueEmail('exact');
    await makeBookings(email, 4);
    const p1 = await ctx.api.get('/bookings').query({ email, limit: 2 });
    const p2 = await ctx.api.get('/bookings').query({ email, limit: 2, cursor: p1.body.next_cursor });
    assert.equal(p2.body.bookings.length, 2);
    assert.equal(p2.body.next_cursor, null);
  });

  it('defaults to 10 per page', async () => {
    const email = uniqueEmail('dflt');
    await makeBookings(email, 12);
    const res = await ctx.api.get('/bookings').query({ email });
    assert.equal(res.body.bookings.length, 10);
    assert.equal(typeof res.body.next_cursor, 'string');
  });

  it('email match ignores case and includes cancelled bookings', async () => {
    const email = uniqueEmail('case');
    const ids = await makeBookings(email, 2);
    await ctx.api.delete(`/bookings/${ids[0]}`);
    const res = await ctx.api.get('/bookings').query({ email: email.toUpperCase() });
    assert.deepEqual(res.body.bookings.map((b) => [b.id, b.status]), [[ids[0], 'cancelled'], [ids[1], 'confirmed']]);
    assert.equal(res.body.next_cursor, null);
  });

  it('only returns that person\'s bookings', async () => {
    const mine = uniqueEmail('mine');
    await ctx.book({ slot_id: 's1', name: 'Ada', email: mine });
    await ctx.book({ slot_id: 's2', name: 'Bola', email: uniqueEmail('other') });
    const res = await ctx.api.get('/bookings').query({ email: mine });
    assert.equal(res.body.bookings.length, 1);
    assert.equal(res.body.bookings[0].email, mine);
  });

  it('no bookings returns an empty page', async () => {
    const res = await ctx.api.get('/bookings').query({ email: 'nobody@example.com' });
    assert.deepEqual(res.body, { bookings: [], next_cursor: null });
  });

  for (const limit of ['0', '51', '-1', 'abc', '1.5', '']) {
    it(`limit=${JSON.stringify(limit)} is 400`, async () => {
      const res = await ctx.api.get('/bookings').query({ email: 'a@b.co', limit });
      assert.equal(res.status, 400);
      assert.equal(typeof res.body.error, 'string');
    });
  }

  it('limit 1 and 50 are accepted', async () => {
    for (const limit of ['1', '50']) {
      const res = await ctx.api.get('/bookings').query({ email: 'a@b.co', limit });
      assert.equal(res.status, 200);
    }
  });

  it('missing email is 400; garbage cursor is 400', async () => {
    assert.equal((await ctx.api.get('/bookings')).status, 400);
    assert.equal((await ctx.api.get('/bookings').query({ email: 'a@b.co', cursor: 'garbage!!' })).status, 400);
  });
});
