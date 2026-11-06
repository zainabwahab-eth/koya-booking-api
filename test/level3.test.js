import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uniqueEmail } from './helpers.js';

const ctx = setupTestApp();

describe('Level 3: no double booking', () => {
  it('a second booking for a confirmed slot is 409', async () => {
    const first = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    assert.equal(first.status, 201);
    const second = await ctx.book({ slot_id: 's1', name: 'Bola', email: uniqueEmail() });
    assert.equal(second.status, 409);
    assert.deepEqual(Object.keys(second.body), ['error']);
  });

  it('50 simultaneous bookings for one slot: exactly one 201, the rest 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => ctx.book({ slot_id: 's2', name: `Patient ${i}`, email: uniqueEmail('race') })),
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 409).length, 49);
    const confirmed = await ctx.db.collection('bookings').countDocuments({ slot_id: 's2', status: 'confirmed' });
    assert.equal(confirmed, 1);
  });

  it('simultaneous bookings across different slots all succeed', async () => {
    const results = await Promise.all(
      ['s1', 's2', 's3'].map((slot_id) => ctx.book({ slot_id, name: 'Ada', email: uniqueEmail() })),
    );
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
  });
});

describe('Level 3: cancellation', () => {
  it('DELETE /bookings/:id returns the booking with status cancelled', async () => {
    const created = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.api.delete(`/bookings/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ...created.body, status: 'cancelled' });
    const look = await ctx.api.get(`/bookings/${created.body.id}`);
    assert.equal(look.body.status, 'cancelled');
  });

  it('cancelling frees the slot so it can be booked again', async () => {
    const created = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    await ctx.api.delete(`/bookings/${created.body.id}`);
    const slots = await ctx.api.get('/slots');
    assert.equal(slots.body.slots.find((s) => s.id === 's1').available, true);
    const again = await ctx.book({ slot_id: 's1', name: 'Bola', email: uniqueEmail() });
    assert.equal(again.status, 201);
    assert.notEqual(again.body.id, created.body.id);
  });

  it('cancelling twice is 409; unknown id is 404', async () => {
    const created = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    assert.equal((await ctx.api.delete(`/bookings/${created.body.id}`)).status, 200);
    const twice = await ctx.api.delete(`/bookings/${created.body.id}`);
    assert.equal(twice.status, 409);
    assert.equal(typeof twice.body.error, 'string');
    const missing = await ctx.api.delete('/bookings/nope');
    assert.equal(missing.status, 404);
  });

  it('simultaneous cancels of one booking: exactly one 200', async () => {
    const created = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    const results = await Promise.all(Array.from({ length: 10 }, () => ctx.api.delete(`/bookings/${created.body.id}`)));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 9);
  });
});
