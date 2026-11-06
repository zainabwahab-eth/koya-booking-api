#!/usr/bin/env node
/**
 * Fills the database with demo slots for the web page: the next 5 weekdays, 3 doctors,
 * 30-minute slots from 09:00 to 12:00 UTC.
 *
 *   npm run seed
 *
 * WARNING: same as POST /reset. Deletes every booking and replaces all slots.
 */
import { connect } from '../src/db.js';
import { resetSlots } from '../src/services/slots.js';

const PROVIDERS = ['Dr Ade', 'Dr Bello', 'Dr Chukwu'];
const HOURS = [9, 9.5, 10, 10.5, 11, 11.5];
const iso = (d) => d.toISOString().replace('.000Z', 'Z');

export function demoSlots(from = new Date()) {
  const slots = [];
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let days = 0;
  while (days < 5) {
    day.setUTCDate(day.getUTCDate() + 1);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days++;
    const ymd = day.toISOString().slice(0, 10).replaceAll('-', '');
    PROVIDERS.forEach((provider, p) => {
      HOURS.forEach((h) => {
        const start = new Date(day.getTime() + h * 3600_000);
        const end = new Date(start.getTime() + 30 * 60_000);
        const hhmm = start.toISOString().slice(11, 16).replace(':', '');
        slots.push({ id: `${ymd}-${hhmm}-d${p + 1}`, provider, start: iso(start), end: iso(end) });
      });
    });
  }
  return slots;
}

const { client, db } = await connect(process.env.DATABASE_URL, process.env.DB_NAME || 'koya_booking');
try {
  const slots = demoSlots();
  await resetSlots(db, slots);
  console.log(`Seeded ${slots.length} slots (${slots[0].start} to ${slots[slots.length - 1].end}).`);
} finally {
  await client.close();
}
