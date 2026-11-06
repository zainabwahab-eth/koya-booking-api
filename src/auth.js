import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest();

/** Requires the X-API-Key header to equal `apiKey` (level 2). Constant-time comparison. */
export function requireApiKey(apiKey) {
  if (!apiKey) throw new Error('API_KEY is not set');
  const expected = digest(apiKey);
  return (req, res, next) => {
    const given = req.get('X-API-Key');
    if (typeof given !== 'string' || given === '' || !timingSafeEqual(digest(given), expected)) {
      return res.status(401).json({ error: 'missing or invalid API key' });
    }
    next();
  };
}
