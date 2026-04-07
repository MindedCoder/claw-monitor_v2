import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';

export class SessionStore {
  #ttl;

  constructor(ttlMs = 7 * 24 * 3600 * 1000) {
    this.#ttl = ttlMs;
  }

  get #col() {
    return getDb().collection('sessions');
  }

  async create(userData) {
    const id = randomBytes(12).toString('hex');
    const now = new Date();
    await this.#col.insertOne({
      _id: id,
      phone: userData.phone || null,
      user: userData,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#ttl),
    });
    return id;
  }

  async get(id) {
    const doc = await this.#col.findOne({ _id: id });
    if (!doc) return null;
    if (new Date() > doc.expiresAt) {
      await this.#col.deleteOne({ _id: id });
      return null;
    }
    return doc.user;
  }

  async destroy(id) {
    await this.#col.deleteOne({ _id: id });
  }
}
