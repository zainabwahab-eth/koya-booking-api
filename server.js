import { connect } from './src/db.js';
import { createApp } from './app.js';

const { DATABASE_URL, DB_NAME = 'koya_booking', API_KEY, PORT = '3000' } = process.env;

if (!API_KEY) {
  console.error('API_KEY is not set');
  process.exit(1);
}

const { client, db } = await connect(DATABASE_URL, DB_NAME);
const app = createApp({ db, apiKey: API_KEY });

const server = app.listen(Number(PORT), () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: Number(PORT), db: DB_NAME }));
});

// Cloud Run (and most hosts) send SIGTERM before stopping an instance.
const shutdown = (signal) => {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  server.close(() => client.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
