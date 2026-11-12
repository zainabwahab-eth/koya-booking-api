import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requireApiKey } from './src/auth.js';
import { apiRouter } from './src/routes/api.js';
import { uiRouter } from './src/routes/ui.js';
import { DEFAULT_RATE_LIMIT } from './src/services/rateLimit.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function assetHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
}

/**
 * Builds the Express app. Kept separate from server.js so tests can run it against an
 * in-memory MongoDB without opening a port or touching real data.
 *
 * Route order matters:
 *   1. Public: /healthz, static files and the web page (no API key).
 *   2. Everything else needs X-API-Key, including unknown paths (they 401 before they 404).
 */
export function createApp({ db, apiKey, rateLimitConfig = DEFAULT_RATE_LIMIT }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('views', path.join(here, 'views'));
  app.set('view engine', 'pug');
  // The stylesheet URL carries a hash of its contents (styles.css?v=<hash>), so a changed
  // file always gets a new URL and browsers can never show new pages with old styles.
  app.locals.cssUrl = `/public/styles.css?v=${assetHash(path.join(here, 'public', 'styles.css'))}`;

  // Cloud Run reserves paths ending in "z" (its front end answers /healthz itself), so /health is the public one.
  app.get(['/health', '/healthz'], (req, res) => res.json({ ok: true }));
  app.use('/public', express.static(path.join(here, 'public'), { maxAge: '1y', immutable: true }));
  app.use(uiRouter({ db, rateLimitConfig }));

  app.use(requireApiKey(apiKey));
  app.use(express.json({ limit: '100kb' }));
  app.use(apiRouter({ db, rateLimitConfig }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'request body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request body is too large' });
    console.error(JSON.stringify({ level: 'error', msg: err.message, stack: err.stack, path: req.path }));
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
