import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uniqueEmail, API_KEY } from './helpers.js';

const ctx = setupTestApp();

describe('Web page', () => {
  it('GET / lists slots without needing an API key, and never leaks the key', async () => {
    const res = await ctx.http().get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Dr Ade/);
    assert.match(res.text, /Dr Bello/);
    assert.ok(!res.text.includes(API_KEY));
  });

  it('booking through the form redirects to the confirmation page', async () => {
    const email = uniqueEmail('web');
    const res = await ctx
      .http()
      .post('/book')
      .type('form')
      .send({ slot_id: 's1', name: 'Ada Obi', email, idempotency_key: 'form-1' });
    assert.equal(res.status, 303);
    assert.match(res.headers.location, /^\/confirmation\//);

    const page = await ctx.http().get(res.headers.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /You&#39;re booked in|You're booked in/);
    assert.match(page.text, /Ada Obi/);
    assert.match(page.text, /Dr Ade/);

    const id = decodeURIComponent(res.headers.location.split('/').pop());
    const api = await ctx.api.get(`/bookings/${id}`);
    assert.equal(api.body.status, 'confirmed');
  });

  it('double-submitting the form (same hidden key) creates one booking', async () => {
    const form = { slot_id: 's2', name: 'Ada', email: uniqueEmail(), idempotency_key: 'form-dup' };
    const a = await ctx.http().post('/book').type('form').send(form);
    const b = await ctx.http().post('/book').type('form').send(form);
    assert.equal(a.headers.location, b.headers.location);
    assert.equal(await ctx.db.collection('bookings').countDocuments({}), 1);
  });

  it('shows the error and keeps the form values on a bad booking', async () => {
    const res = await ctx.http().post('/book').type('form').send({ slot_id: 's1', name: 'Ada', email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.match(res.text, /email is not valid/);
    assert.match(res.text, /value="Ada"/);
  });

  it('shows a taken slot as booked', async () => {
    await ctx.book({ slot_id: 's1', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.http().get('/');
    assert.match(res.text, /Booked/);
  });

  it('cancel button cancels and the page says so', async () => {
    const created = await ctx.book({ slot_id: 's3', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.http().post(`/confirmation/${created.body.id}/cancel`);
    assert.equal(res.status, 303);
    const page = await ctx.http().get(res.headers.location);
    assert.match(page.text, /Booking cancelled/);
    assert.equal((await ctx.api.get(`/bookings/${created.body.id}`)).body.status, 'cancelled');
  });

  it('unknown booking id shows a 404 page', async () => {
    const res = await ctx.http().get('/confirmation/nope');
    assert.equal(res.status, 404);
    assert.match(res.text, /Not found/);
  });

  it('/healthz is public', async () => {
    const res = await ctx.http().get('/healthz');
    assert.equal(res.status, 200);
  });
});
