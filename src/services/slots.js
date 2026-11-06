import { COLLECTIONS } from '../db.js';

/**
 * Slots keep the exact start/end strings the client sent (so responses echo them back unchanged)
 * plus parsed Dates used for sorting and the "already started" check.
 */
export function toSlotDoc(slot) {
  return {
    _id: slot.id,
    provider: slot.provider,
    start: slot.start,
    end: slot.end,
    start_at: new Date(slot.start),
    end_at: new Date(slot.end),
  };
}

export function toSlotJson(doc, available) {
  const out = { id: doc._id, provider: doc.provider, start: doc.start, end: doc.end };
  if (available !== undefined) out.available = available;
  return out;
}

/** Deletes every booking and replaces all slots. Also clears idempotency and rate limit state. */
export async function resetSlots(db, slots) {
  await Promise.all([
    db.collection(COLLECTIONS.bookings).deleteMany({}),
    db.collection(COLLECTIONS.idempotencyKeys).deleteMany({}),
    db.collection(COLLECTIONS.rateLimits).deleteMany({}),
    db.collection(COLLECTIONS.slots).deleteMany({}),
  ]);
  if (slots.length > 0) {
    await db.collection(COLLECTIONS.slots).insertMany(slots.map(toSlotDoc), { ordered: false });
  }
}

/** Every slot (optionally one provider's), earliest start first, with availability. */
export async function listSlots(db, { provider } = {}) {
  const filter = provider !== undefined ? { provider } : {};
  const slots = await db
    .collection(COLLECTIONS.slots)
    .find(filter)
    .sort({ start_at: 1, _id: 1 })
    .toArray();
  if (slots.length === 0) return [];

  const booked = await db
    .collection(COLLECTIONS.bookings)
    .find({ status: 'confirmed', slot_id: { $in: slots.map((s) => s._id) } }, { projection: { slot_id: 1 } })
    .toArray();
  const bookedIds = new Set(booked.map((b) => b.slot_id));

  return slots.map((s) => toSlotJson(s, !bookedIds.has(s._id)));
}

export async function getSlot(db, id) {
  return db.collection(COLLECTIONS.slots).findOne({ _id: id });
}
