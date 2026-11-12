import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getSlot, listSlots } from '../services/slots.js';
import { cancelBooking, createBooking, getBooking } from '../services/bookings.js';

/**
 * The booking web page, in three steps:
 *   1. GET /                    choose a doctor (with open slot count and next opening)
 *   2. GET /doctors/:provider   that doctor's open times, grouped by day, plus the details form
 *   3. GET /confirmation/:id    the confirmation, with a cancel button
 *
 * It is rendered on the server and calls the same booking service the JSON API uses
 * (validation, double-booking guard, idempotency, rate limit), so the API key never
 * reaches the browser.
 */

const dayFmt = new Intl.DateTimeFormat('en-GB', {
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
  const started = start.getTime() <= now.getTime();
  return {
    ...slot,
    date: dayFmt.format(start),
    startTime: timeFmt.format(start),
    endTime: timeFmt.format(end),
    time: `${timeFmt.format(start)} to ${timeFmt.format(end)} UTC`,
    started,
    open: slot.available !== false && !started,
  };
}

/** [{ date, slots: [...] }] in slot order (slots already come sorted by start). */
function groupByDay(slots) {
  const days = [];
  for (const slot of slots) {
    const last = days[days.length - 1];
    if (last && last.date === slot.date) last.slots.push(slot);
    else days.push({ date: slot.date, slots: [slot] });
  }
  return days;
}

/** One entry per provider: open slot count and the next open slot. Sorted by name. */
export function summarizeDoctors(slots) {
  const byName = new Map();
  for (const slot of slots) {
    if (!byName.has(slot.provider)) byName.set(slot.provider, { name: slot.provider, open: 0, next: null });
    const doc = byName.get(slot.provider);
    if (slot.open) {
      doc.open += 1;
      if (!doc.next) doc.next = slot;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const initials = (name) =>
  name
    .replace(/^(dr|doctor)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

const doctorUrl = (provider) => `/doctors/${encodeURIComponent(provider)}`;

async function renderDoctors(db, res, { status = 200, error = null } = {}) {
  const now = new Date();
  const slots = (await listSlots(db)).map((s) => describeSlot(s, now));
  res.status(status).render('index', {
    doctors: summarizeDoctors(slots).map((d) => ({ ...d, initials: initials(d.name), url: doctorUrl(d.name) })),
    error,
  });
}

/** Returns false if the provider has no slots at all (caller shows 404). */
async function renderDoctor(db, res, provider, { status = 200, error = null, form = {} } = {}) {
  const now = new Date();
  const slots = (await listSlots(db, { provider })).map((s) => describeSlot(s, now));
  if (slots.length === 0) return false;
  const open = slots.filter((s) => s.open);
  res.status(status).render('doctor', {
    doctor: { name: provider, initials: initials(provider), open: open.length },
    days: groupByDay(open),
    error,
    form,
    idempotencyKey: randomUUID(),
  });
  return true;
}

const notFound = (res, message) => res.status(404).render('not-found', { message });

export function uiRouter({ db, rateLimitConfig }) {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '10kb' });

  r.get('/', async (req, res) => {
    // old links used /?provider=Name; send them to the doctor page
    if (typeof req.query.provider === 'string' && req.query.provider) {
      return res.redirect(301, doctorUrl(req.query.provider));
    }
    await renderDoctors(db, res);
  });

  r.get('/doctors/:provider', async (req, res) => {
    const shown = await renderDoctor(db, res, req.params.provider);
    if (!shown) notFound(res, `We couldn't find a doctor called "${req.params.provider}".`);
  });

  r.post('/book', form, async (req, res) => {
    const body = { slot_id: req.body.slot_id, name: req.body.name, email: req.body.email };
    const key =
      typeof req.body.idempotency_key === 'string' && req.body.idempotency_key ? req.body.idempotency_key : undefined;
    const result = await createBooking(db, { body, idempotencyKey: key, rateLimitConfig });

    if (result.status === 201) return res.redirect(303, `/confirmation/${encodeURIComponent(result.body.id)}`);
    if (result.headers) res.set(result.headers);

    const error = friendlyError(result);
    const provider = typeof req.body.provider === 'string' ? req.body.provider : '';
    if (provider && (await renderDoctor(db, res, provider, { status: result.status, error, form: body }))) return;
    await renderDoctors(db, res, { status: result.status, error });
  });

  r.get('/lookup', (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!id) return res.redirect(303, '/');
    res.redirect(303, `/confirmation/${encodeURIComponent(id)}`);
  });

  r.get('/confirmation/:id', async (req, res) => {
    const booking = await getBooking(db, req.params.id);
    if (!booking) return notFound(res, `No booking found with id "${req.params.id}".`);
    const slot = await getSlot(db, booking.slot_id);
    res.render('confirmation', {
      booking,
      slot: slot
        ? {
            ...describeSlot({ id: slot._id, provider: slot.provider, start: slot.start, end: slot.end }, new Date()),
            url: doctorUrl(slot.provider),
          }
        : null,
      notice: req.query.cancelled === '1' ? 'Your booking has been cancelled.' : null,
    });
  });

  r.post('/confirmation/:id/cancel', async (req, res) => {
    const result = await cancelBooking(db, req.params.id);
    if (result.status === 404) return notFound(res, `No booking found with id "${req.params.id}".`);
    res.redirect(303, `/confirmation/${encodeURIComponent(req.params.id)}?cancelled=1`);
  });

  return r;
}

/** API error messages are terse; the page says the same thing in patient-facing words. */
function friendlyError({ status, body, headers }) {
  const msg = body?.error || 'Something went wrong';
  if (status === 409) return 'Sorry, someone just booked that time. Please pick another one.';
  if (status === 429) return `Too many booking attempts for this email. Please try again in ${headers?.['Retry-After'] ?? 60} seconds.`;
  if (msg === 'slot_id is required') return 'Please pick a time.';
  if (msg === 'name is required') return 'Please enter your full name.';
  if (msg === 'email is required') return 'Please enter your email.';
  if (msg === 'email is not valid') return 'That email address does not look right.';
  if (msg === 'slot has already started') return 'That time has already started. Please pick a later one.';
  if (msg === 'slot not found') return 'That time is no longer available. Please pick another one.';
  return msg.charAt(0).toUpperCase() + msg.slice(1) + '.';
}
