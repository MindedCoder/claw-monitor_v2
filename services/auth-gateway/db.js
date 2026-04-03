import { MongoClient } from 'mongodb';

let client = null;
let db = null;

export async function connectDb(config) {
  const uri = config.mongodb?.uri;
  const dbName = config.mongodb?.database || 'claw_auth';
  if (!uri) throw new Error('[db] mongodb.uri is required');

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);

  // TTL indexes — MongoDB auto-deletes expired docs
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('codes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  console.log(`[db] connected to ${dbName}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('[db] not connected');
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
