import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uniqueEmail } from './helpers.js';

const ctx = setupTestApp();

describe('Level 1: list slots, book, look up', () => {
  it('POST /reset replaces slots and returns 200', async () => {
    const res = await ctx.reset([{ id: 'x1', provider: 'Dr X', start: '2030-01-01T09:00:00Z', end: '2030-01-01T09:30:00Z' }]);
    assert.equal(res.status, 200);
    const slots = await ctx.api.get('/slots');
    assert.deepEqual(slots.body, {
      slots: [{ id: 'x1', provider: 'Dr X', start: '2030-01-01T09:00:00Z', end: '2030-01-01T09:30:00Z', available: true }],
    });
  });

  it('POST /reset accepts past slots and deletes every booking', async () => {
    const b = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    assert.equal(b.status, 201);
    await ctx.reset();
    const look = await ctx.api.get(`/bookings/${b.body.id}`);
    assert.equal(look.status, 404);
    const slots = await ctx.api.get('/slots');
    assert.ok(slots.body.slots.some((s) => s.id === 'past1'));
  });

  it('POST /reset rejects a body without a slots array', async () => {
    const res = await ctx.api.post('/reset').send({ nope: [] });
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
  });

  it('GET /slots lists every slot, earliest start first, with availability', async () => {
    const res = await ctx.api.get('/slots');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.slots.map((s) => s.id), ['past1', 's1', 's2', 's3']);
    for (const s of res.body.slots) {
      assert.deepEqual(Object.keys(s).sort(), ['available', 'end', 'id', 'provider', 'start']);
      assert.equal(s.available, true);
    }
  });

  it('GET /slots?provider= filters by exact provider name', async () => {
    const res = await ctx.api.get('/slots').query({ provider: 'Dr Ade' });
    assert.deepEqual(res.body.slots.map((s) => s.id), ['past1', 's1', 's3']);
    const none = await ctx.api.get('/slots').query({ provider: 'dr ade' });
    assert.deepEqual(none.body.slots, []);
  });

  it('POST /bookings returns 201 with a confirmed booking', async () => {
    const email = uniqueEmail('ada');
    const res = await ctx.book({ slot_id: 's1', name: 'Ada Obi', email });
    assert.equal(res.status, 201);
    assert.equal(typeof res.body.id, 'string');
    assert.equal(res.body.slot_id, 's1');
    assert.equal(res.body.name, 'Ada Obi');
    assert.equal(res.body.email, email);
    assert.equal(res.body.status, 'confirmed');
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
  });

  it('a booked slot shows available: false', async () => {
    await ctx.book({ slot_id: 's2', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.api.get('/slots');
    const byId = Object.fromEntries(res.body.slots.map((s) => [s.id, s.available]));
    assert.deepEqual(byId, { past1: true, s1: true, s2: false, s3: true });
  });

  it('GET /bookings/:id returns the booking; unknown id is 404', async () => {
    const created = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.api.get(`/bookings/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created.body);

    const missing = await ctx.api.get('/bookings/does-not-exist');
    assert.equal(missing.status, 404);
    assert.deepEqual(Object.keys(missing.body), ['error']);
  });

  it('bookings persist across app instances (stored in the database)', async () => {
    const { createApp } = await import('../app.js');
    const request = (await import('supertest')).default;
    const created = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    const fresh = createApp({ db: ctx.db, apiKey: 'test-key-123' });
    const res = await request(fresh).get(`/bookings/${created.body.id}`).set('X-API-Key', 'test-key-123');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
  });
});
