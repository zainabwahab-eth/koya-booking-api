// One in-memory MongoDB for the whole test run. Each test file gets its own database on it,
// so files still run in parallel without sharing data (and without 6 mongod processes racing to start).
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod;

export async function globalSetup() {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  process.env.TEST_MONGO_URI = mongod.getUri();
}

export async function globalTeardown() {
  await mongod?.stop();
}
