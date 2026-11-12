import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uniqueEmail, API_KEY } from './helpers.js';
import { summarizeDoctors } from '../src/routes/ui.js';

const ctx = setupTestApp();
const doctorPage = (name) => `/doctors/${encodeURIComponent(name)}`;
const bookForm = (fields) => ctx.http().post('/book').type('form').send(fields);

describe('Web page, step 1: choose a doctor', () => {
  it('GET / lists each doctor once with a link, without needing an API key, and never leaks the key', async () => {
    const res = await ctx.http().get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Choose a doctor/);
    assert.match(res.text, /href="\/doctors\/Dr%20Ade"/);
    assert.match(res.text, /href="\/doctors\/Dr%20Bello"/);
    assert.equal(res.text.match(/class="doctor-name"/g).length, 2);
    assert.ok(!res.text.includes(API_KEY));
  });

  it('does not list individual slot times on the doctor list', async () => {
    const res = await ctx.http().get('/');
    assert.ok(!res.text.includes('name="slot_id"'));
  });

  it('shows open counts: Dr Ade has 2 open (s1, s3; past1 has started), Dr Bello 1', async () => {
    const res = await ctx.http().get('/');
    assert.match(res.text, /Dr Ade[\s\S]*?2 open/);
    assert.match(res.text, /Dr Bello[\s\S]*?1 open/);
  });

  it('a fully booked doctor is shown but not clickable', async () => {
    await ctx.book({ slot_id: 's2', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.http().get('/');
    assert.match(res.text, /Fully booked/);
    assert.ok(!res.text.includes('href="/doctors/Dr%20Bello"'));
  });

  it('old /?provider= links redirect to the doctor page', async () => {
    const res = await ctx.http().get('/?provider=Dr%20Ade');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, doctorPage('Dr Ade'));
  });

  it('summarizeDoctors counts only open slots and picks the earliest as next', () => {
    const out = summarizeDoctors([
      { id: 'a', provider: 'Dr B', open: false },
      { id: 'b', provider: 'Dr B', open: true },
      { id: 'c', provider: 'Dr A', open: true },
      { id: 'd', provider: 'Dr B', open: true },
    ]);
    assert.deepEqual(out.map((d) => [d.name, d.open, d.next?.id]), [['Dr A', 1, 'c'], ['Dr B', 2, 'b']]);
  });
});

describe('Web page, step 2: pick a time', () => {
  it('shows only that doctor\'s open times', async () => {
    await ctx.book({ slot_id: 's3', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.http().get(doctorPage('Dr Ade'));
    assert.equal(res.status, 200);
    assert.match(res.text, /value="s1"/);
    assert.ok(!res.text.includes('value="s3"'), 'booked slot should be hidden');
    assert.ok(!res.text.includes('value="past1"'), 'started slot should be hidden');
    assert.ok(!res.text.includes('value="s2"'), 'other doctor\'s slot should be hidden');
    assert.match(res.text, /name="provider" value="Dr Ade"/);
  });

  it('a doctor with no open times says so', async () => {
    await ctx.book({ slot_id: 's2', name: 'Ada', email: uniqueEmail() });
    const res = await ctx.http().get(doctorPage('Dr Bello'));
    assert.equal(res.status, 200);
    assert.match(res.text, /fully booked right now/);
  });

  it('unknown doctor is a 404 page', async () => {
    const res = await ctx.http().get(doctorPage('Dr Nobody'));
    assert.equal(res.status, 404);
    assert.match(res.text, /Not found/);
  });
});

describe('Web page, step 3: book and confirm', () => {
  it('booking redirects to the confirmation page', async () => {
    const res = await bookForm({ slot_id: 's1', provider: 'Dr Ade', name: 'Ada Obi', email: uniqueEmail('web'), idempotency_key: 'form-1' });
    assert.equal(res.status, 303);
    assert.match(res.headers.location, /^\/confirmation\//);

    const page = await ctx.http().get(res.headers.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /You&#39;re booked in|You're booked in/);
    assert.match(page.text, /Ada Obi/);
    assert.match(page.text, /Dr Ade/);
    assert.match(page.text, /Book another time with Dr Ade/);

    const id = decodeURIComponent(res.headers.location.split('/').pop());
    assert.equal((await ctx.api.get(`/bookings/${id}`)).body.status, 'confirmed');
  });

  it('double-submitting (same hidden key) creates one booking', async () => {
    const form = { slot_id: 's2', provider: 'Dr Bello', name: 'Ada', email: uniqueEmail(), idempotency_key: 'form-dup' };
    const a = await bookForm(form);
    const b = await bookForm(form);
    assert.equal(a.headers.location, b.headers.location);
    assert.equal(await ctx.db.collection('bookings').countDocuments({}), 1);
  });

  it('a bad email re-shows the doctor page with a friendly error and keeps the values', async () => {
    const res = await bookForm({ slot_id: 's1', provider: 'Dr Ade', name: 'Ada', email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.match(res.text, /That email address does not look right/);
    assert.match(res.text, /value="Ada"/);
    assert.match(res.text, /Pick a time/);
    assert.match(res.text, /value="s1" checked/);
  });

  it('no time picked says "Please pick a time"', async () => {
    const res = await bookForm({ provider: 'Dr Ade', name: 'Ada', email: uniqueEmail() });
    assert.equal(res.status, 400);
    assert.match(res.text, /Please pick a time/);
  });

  it('a time someone else just took gives a friendly 409', async () => {
    await ctx.book({ slot_id: 's1', name: 'Bola', email: uniqueEmail() });
    const res = await bookForm({ slot_id: 's1', provider: 'Dr Ade', name: 'Ada', email: uniqueEmail() });
    assert.equal(res.status, 409);
    assert.match(res.text, /someone just booked that time/);
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
    assert.equal((await ctx.http().get('/healthz')).status, 200);
  });
});
