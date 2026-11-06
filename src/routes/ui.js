import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getSlot, listSlots } from '../services/slots.js';
import { cancelBooking, createBooking, getBooking } from '../services/bookings.js';

/**
 * The booking web page. It is rendered on the server and calls the same booking service the
 * JSON API uses (same validation, double-booking guard, idempotency and rate limit), so the
 * API key never has to be shipped to the browser.
 */

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

function describeSlot(slot, now) {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  return {
    ...slot,
    date: dateFmt.format(start),
    time: `${timeFmt.format(start)} to ${timeFmt.format(end)} UTC`,
    started: start.getTime() <= now.getTime(),
  };
}

async function renderHome(db, res, { status = 200, error = null, form = {}, provider } = {}) {
  const now = new Date();
  const all = await listSlots(db);
  const providers = [...new Set(all.map((s) => s.provider))].sort();
  const shown = provider ? all.filter((s) => s.provider === provider) : all;
  res.status(status).render('index', {
    slots: shown.map((s) => describeSlot(s, now)),
    providers,
    provider: provider || '',
    error,
    form,
    idempotencyKey: randomUUID(),
  });
}

export function uiRouter({ db, rateLimitConfig }) {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '10kb' });

  r.get('/', async (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
    await renderHome(db, res, { provider });
  });

  r.post('/book', form, async (req, res) => {
    const body = { slot_id: req.body.slot_id, name: req.body.name, email: req.body.email };
    const key = typeof req.body.idempotency_key === 'string' && req.body.idempotency_key ? req.body.idempotency_key : undefined;
    const result = await createBooking(db, { body, idempotencyKey: key, rateLimitConfig });

    if (result.status === 201) return res.redirect(303, `/confirmation/${encodeURIComponent(result.body.id)}`);
    if (result.headers) res.set(result.headers);
    await renderHome(db, res, { status: result.status, error: result.body.error, form: body });
  });

  r.get('/lookup', (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!id) return res.redirect(303, '/');
    res.redirect(303, `/confirmation/${encodeURIComponent(id)}`);
  });

  r.get('/confirmation/:id', async (req, res) => {
    const booking = await getBooking(db, req.params.id);
    if (!booking) {
      return res.status(404).render('not-found', { message: `No booking found with id "${req.params.id}".` });
    }
    const slot = await getSlot(db, booking.slot_id);
    res.render('confirmation', {
      booking,
      slot: slot ? describeSlot({ id: slot._id, provider: slot.provider, start: slot.start, end: slot.end }, new Date()) : null,
      notice: req.query.cancelled === '1' ? 'Your booking has been cancelled.' : null,
    });
  });

  r.post('/confirmation/:id/cancel', async (req, res) => {
    const result = await cancelBooking(db, req.params.id);
    if (result.status === 404) {
      return res.status(404).render('not-found', { message: `No booking found with id "${req.params.id}".` });
    }
    res.redirect(303, `/confirmation/${encodeURIComponent(req.params.id)}?cancelled=1`);
  });

  return r;
}
