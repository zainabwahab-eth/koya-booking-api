import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uniqueEmail } from './helpers.js';

const ctx = setupTestApp();

describe('Level 2: API key', () => {
  const routes = [
    ['get', '/slots'],
    ['post', '/bookings'],
    ['get', '/bookings?email=a@b.co'],
    ['get', '/bookings/abc'],
    ['delete', '/bookings/abc'],
    ['post', '/reset'],
    ['get', '/no-such-route'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} without a key is 401`, async () => {
      const res = await ctx.http()[method](path);
      assert.equal(res.status, 401);
      assert.equal(typeof res.body.error, 'string');
    });
    it(`${method.toUpperCase()} ${path} with a wrong key is 401`, async () => {
      const res = await ctx.http()[method](path).set('X-API-Key', 'wrong');
      assert.equal(res.status, 401);
    });
  }

  it('the correct key gets in', async () => {
    const res = await ctx.api.get('/slots');
    assert.equal(res.status, 200);
  });
});

describe('Level 2: booking validation', () => {
  const bad = [
    ['missing slot_id', { name: 'Ada', email: 'ada@example.com' }],
    ['empty slot_id', { slot_id: '', name: 'Ada', email: 'ada@example.com' }],
    ['missing name', { slot_id: 's1', email: 'ada@example.com' }],
    ['empty name', { slot_id: 's1', name: '', email: 'ada@example.com' }],
    ['whitespace name', { slot_id: 's1', name: '   ', email: 'ada@example.com' }],
    ['missing email', { slot_id: 's1', name: 'Ada' }],
    ['empty email', { slot_id: 's1', name: 'Ada', email: '' }],
    ['whitespace email', { slot_id: 's1', name: 'Ada', email: '   ' }],
    ['email without @', { slot_id: 's1', name: 'Ada', email: 'ada.example.com' }],
    ['email without domain dot', { slot_id: 's1', name: 'Ada', email: 'ada@example' }],
    ['email with space', { slot_id: 's1', name: 'Ada', email: 'ada obi@example.com' }],
    ['non-string name', { slot_id: 's1', name: 42, email: 'ada@example.com' }],
    ['non-string slot_id', { slot_id: 1, name: 'Ada', email: 'ada@example.com' }],
  ];

  for (const [label, body] of bad) {
    it(`400 for ${label}`, async () => {
      // unique email per case where an email is present keeps the rate limiter out of the way
      const b = typeof body.email === 'string' && body.email.includes('@') && !body.email.includes(' ')
        ? { ...body, email: body.email.replace('ada', `ada${Math.random().toString(36).slice(2)}`) }
        : body;
      const res = await ctx.book(b);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body), ['error']);
    });
  }

  it('400 for a body that is not valid JSON', async () => {
    const res = await ctx.api.post('/bookings').set('Content-Type', 'application/json').send('{"slot_id":');
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
  });

  it('400 for a JSON array body', async () => {
    const res = await ctx.api.post('/bookings').send([]);
    assert.equal(res.status, 400);
  });

  it('404 when the slot does not exist', async () => {
    const res = await ctx.book({ slot_id: 'nope', name: 'Ada', email: uniqueEmail() });
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
  });

  it('400 when the slot has already started', async () => {
    const res = await ctx.book({ slot_id: 'past1', name: 'Ada', email: uniqueEmail() });
    assert.equal(res.status, 400);
  });

  it('validation runs before the slot lookup (bad email on unknown slot is 400, not 404)', async () => {
    const res = await ctx.book({ slot_id: 'nope', name: 'Ada', email: 'bad' });
    assert.equal(res.status, 400);
  });

  it('trims name and email and lower-cases email', async () => {
    const email = uniqueEmail('Mixed');
    const res = await ctx.book({ slot_id: 's1', name: '  Ada Obi  ', email: `  ${email.toUpperCase()}  ` });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Ada Obi');
    assert.equal(res.body.email, email.toLowerCase());
    const look = await ctx.api.get(`/bookings/${res.body.id}`);
    assert.equal(look.body.email, email.toLowerCase());
  });
});
