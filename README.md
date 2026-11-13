# Clinic Booking API

Patients can list appointment slots, book one, look it up and cancel it. The repo has a JSON API that follows the [Koya assessment spec](https://koyaacademy.com/assessment-api) and a server-rendered booking page that uses it.

**Stack:** Node 24, Express 5, MongoDB (Atlas), Pug. Tests use the built-in `node:test` runner with Supertest and an in-memory MongoDB.

**Live:** https://koya-booking-api-254525890059.europe-west1.run.app (Google Cloud Run, europe-west1). The API endpoints are at the root, and opening the URL in a browser shows the booking page.

## What each level does and where

| Level | Behaviour | How it is enforced | Code |
|---|---|---|---|
| 1 | `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/:id` | Slots are stored with the exact `start`/`end` strings sent, plus parsed dates for sorting | [src/services/slots.js](src/services/slots.js), [src/services/bookings.js](src/services/bookings.js) |
| 2 | `X-API-Key` on every API request (401). 400 for missing, empty or invalid fields, 404 for an unknown slot, 400 for a slot that has started. `name` and `email` are trimmed and `email` is lower-cased | Middleware does a constant-time key compare. Validation runs before the slot lookup | [src/auth.js](src/auth.js), [src/validation.js](src/validation.js) |
| 3 | A slot can never have two confirmed bookings, even under concurrent requests (409). `DELETE /bookings/:id` cancels the booking and frees the slot | A **partial unique index** on `bookings.slot_id` where `status = confirmed`. MongoDB rejects the second insert atomically. Cancel is one atomic `findOneAndUpdate` | [src/db.js](src/db.js) |
| 4 | `Idempotency-Key`: the same key with the same body returns the same response, a different body returns 422. `GET /bookings?email=` pages with a cursor | A key is claimed by inserting a document with `_id = key`, so only one request can own it. Concurrent duplicates wait for the stored response. Body comparison uses a hash of canonical JSON. The cursor is base64url of `(created_at, _id)` | [src/services/idempotency.js](src/services/idempotency.js) |
| 5 | At most 5 attempts per email per minute, failed attempts included. The 6th gets 429 with `Retry-After` | A sliding window per normalized email, stored in MongoDB and updated with one atomic pipeline `findOneAndUpdate`. The limit holds across restarts and multiple instances | [src/services/rateLimit.js](src/services/rateLimit.js) |

Order of operations in `POST /bookings`: API key, then idempotency claim (a replay returns here and doesn't use up a rate-limit attempt), then the rate limit, then validation, then the slot checks, then the insert. A 429 response isn't stored against the idempotency key, so a retry after the wait really runs.

`POST /reset` also clears the idempotency keys and rate-limit windows, so each test run starts clean.

Every error response has the shape `{"error": "<message>"}`.

## Web page

Booking takes three steps:

1. `GET /` lists the doctors, each with its number of open times and next opening. A fully booked doctor is shown but can't be clicked.
2. `GET /doctors/:provider` shows that doctor's open times, grouped by day, with the name and email form. `POST /book` submits it. On an error, the same page comes back with a plain-language message and the form values kept.
3. `GET /confirmation/:id` shows the confirmation, a cancel button, and a link to book another time with the same doctor.

`GET /lookup?id=` (the box in the header) finds a booking by id.

The page is rendered on the server and calls the same booking service as the API. It gets the same validation, double-booking guard, idempotency (a hidden key per form, so a double-click books once) and rate limit. The API key never reaches the browser.

Page routes and `/health` are public. `/healthz` also works locally, but Cloud Run's front end answers paths ending in `z` itself, so use `/health` on the live URL. Everything else requires `X-API-Key`. An unknown path returns 401 without a key and 404 with one.

## Run locally

```bash
cp .env.example .env      # set DATABASE_URL and API_KEY
npm install
npm run seed              # optional: demo slots for the next 5 weekdays (wipes bookings)
npm start                 # http://localhost:3000
```

Atlas only accepts connections from IPs on its **Network Access** list. Add yours, or `0.0.0.0/0`, which Cloud Run needs anyway. If Atlas rejects you, the error is `tlsv1 alert internal error`.

> **Windows note:** if startup fails with `querySrv ECONNREFUSED`, Node is using a local DNS resolver that does not answer the SRV lookup `mongodb+srv://` needs. Add `DNS_SERVERS=8.8.8.8,1.1.1.1` to `.env`. Leave it unset on Cloud Run, where the default resolver works.

## Tests

```bash
npm test
```

100 gate tests run in about 7 seconds against an in-memory MongoDB. Each test file gets its own database. They cover every level, including:

- 50 simultaneous bookings for one slot: exactly one 201 and 49 409s
- 20 simultaneous retries with one `Idempotency-Key`: one booking, the same id every time
- 20 simultaneous attempts for one email: exactly 5 get through
- cursor paging, including the exact-multiple-of-limit edge case
- the web page: booking, double submit, errors, cancel, and a check that the key never leaks

## Contract check against a live deployment

```bash
npm run check -- https://YOUR-SERVICE-URL
```

This runs 17 black-box checks against the real URL, level by level, the way an external grader would. **It calls `/reset`, which wipes all bookings.** Run `npm run seed` afterwards to restore the demo slots.

## Project layout

```
app.js                 Express app factory (routes, auth, error handler)
server.js              Boot: connect to MongoDB, create indexes, listen, graceful shutdown
src/db.js              Connection + indexes (the double-booking guard lives here)
src/auth.js            X-API-Key middleware
src/validation.js      Body / query validation
src/services/          slots, bookings, idempotency, rateLimit
src/routes/api.js      JSON API (the spec)
src/routes/ui.js       Booking web page
views/  public/        Pug templates and CSS
scripts/seed.js        Demo slots
scripts/contract-check.js  Black-box checks against any URL
test/                  node:test gate tests
```
