import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupTestApp, uniqueEmail } from './helpers.js';

const ctx = setupTestApp();

describe('Level 5: at most 5 attempts per email per minute', () => {
  it('the 6th attempt is 429 with Retry-After in whole seconds', async () => {
    const email = uniqueEmail('spam');
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      // nonexistent slot: failed attempts still count
      statuses.push((await ctx.book({ slot_id: 'nope', name: 'Spam', email })).status);
    }
    assert.deepEqual(statuses, [404, 404, 404, 404, 404]);
    const sixth = await ctx.book({ slot_id: 's1', name: 'Spam', email });
    assert.equal(sixth.status, 429);
    assert.equal(typeof sixth.body.error, 'string');
    assert.match(sixth.headers['retry-after'], /^\d+$/);
    const wait = Number(sixth.headers['retry-after']);
    assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`);
  });

  it('validation failures count as attempts', async () => {
    const email = uniqueEmail('bad');
    for (let i = 0; i < 5; i++) {
      assert.equal((await ctx.book({ slot_id: 's1', name: '', email })).status, 400);
    }
    assert.equal((await ctx.book({ slot_id: 's1', name: 'Ok', email })).status, 429);
  });

  it('email is normalized: case and spaces do not get around the limit', async () => {
    const email = uniqueEmail('norm');
    for (let i = 0; i < 5; i++) await ctx.book({ slot_id: 'nope', name: 'x', email });
    const res = await ctx.book({ slot_id: 's1', name: 'x', email: `  ${email.toUpperCase()} ` });
    assert.equal(res.status, 429);
  });

  it('other emails are not affected', async () => {
    const spammer = uniqueEmail('spammer');
    for (let i = 0; i < 6; i++) await ctx.book({ slot_id: 'nope', name: 'x', email: spammer });
    const res = await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail('innocent') });
    assert.equal(res.status, 201);
  });

  it('20 simultaneous attempts for one email: exactly 5 get through', async () => {
    const email = uniqueEmail('burst');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ctx.book({ slot_id: 'nope', name: 'x', email })),
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 404).length, 5, `statuses: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 429).length, 15);
  });

  it('an idempotent replay does not use up an attempt', async () => {
    const email = uniqueEmail('replay');
    const body = { slot_id: 's1', name: 'Ada', email };
    const first = await ctx.book(body, { 'Idempotency-Key': 'rk-1' });
    for (let i = 0; i < 9; i++) {
      const again = await ctx.book(body, { 'Idempotency-Key': 'rk-1' });
      assert.equal(again.status, 201);
      assert.equal(again.body.id, first.body.id);
    }
    // only the first one counted, so 4 more real attempts are still allowed
    for (let i = 0; i < 4; i++) assert.equal((await ctx.book({ ...body, slot_id: 'nope' })).status, 404);
    assert.equal((await ctx.book({ ...body, slot_id: 'nope' })).status, 429);
  });
});

describe('Level 5: window slides', () => {
  const fast = setupTestApp({ rateLimitConfig: { max: 2, windowMs: 1000 } });

  it('attempts are allowed again once the window has passed', async () => {
    const email = uniqueEmail('slide');
    assert.equal((await fast.book({ slot_id: 'nope', name: 'x', email })).status, 404);
    assert.equal((await fast.book({ slot_id: 'nope', name: 'x', email })).status, 404);
    const blocked = await fast.book({ slot_id: 'nope', name: 'x', email });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '1');
    await sleep(1100);
    assert.equal((await fast.book({ slot_id: 'nope', name: 'x', email })).status, 404);
  });
});
