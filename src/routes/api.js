import { Router } from 'express';
import { parseLimit, validateResetBody } from '../validation.js';
import { listSlots, resetSlots } from '../services/slots.js';
import {
  cancelBooking,
  createBooking,
  decodeCursor,
  getBooking,
  listBookingsByEmail,
} from '../services/bookings.js';

const send = (res, { status, body, headers }) => {
  if (headers) res.set(headers);
  res.status(status).json(body);
};

const single = (v) => (typeof v === 'string' ? v : undefined);

export function apiRouter({ db, rateLimitConfig }) {
  const r = Router();

  r.post('/reset', async (req, res) => {
    const { error, value } = validateResetBody(req.body);
    if (error) return res.status(400).json({ error });
    await resetSlots(db, value);
    res.status(200).json({ ok: true, slots: value.length });
  });

  r.get('/slots', async (req, res) => {
    const { provider } = req.query;
    if (provider !== undefined && typeof provider !== 'string') {
      return res.status(400).json({ error: 'provider must be a single value' });
    }
    res.json({ slots: await listSlots(db, { provider }) });
  });

  r.post('/bookings', async (req, res) => {
    const result = await createBooking(db, {
      body: req.body,
      idempotencyKey: req.get('Idempotency-Key'),
      rateLimitConfig,
    });
    send(res, result);
  });

  r.get('/bookings', async (req, res) => {
    const email = single(req.query.email);
    if (!email || email.trim() === '') return res.status(400).json({ error: 'email is required' });

    const limit = parseLimit(req.query.limit);
    if (limit.error) return res.status(400).json({ error: limit.error });

    let cursor = null;
    if (req.query.cursor !== undefined) {
      const raw = single(req.query.cursor);
      cursor = raw ? decodeCursor(raw) : null;
      if (!cursor) return res.status(400).json({ error: 'cursor is not valid' });
    }

    res.json(await listBookingsByEmail(db, { email, limit: limit.value, cursor }));
  });

  r.get('/bookings/:id', async (req, res) => {
    const booking = await getBooking(db, req.params.id);
    if (!booking) return res.status(404).json({ error: 'booking not found' });
    res.json(booking);
  });

  r.delete('/bookings/:id', async (req, res) => {
    send(res, await cancelBooking(db, req.params.id));
  });

  return r;
}
