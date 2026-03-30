import { randomBytes } from 'node:crypto';

export class SessionStore {
  #sessions = new Map();
  #ttl;
  #cleanupTimer;

  constructor(ttlMs = 7 * 24 * 3600 * 1000) {
    this.#ttl = ttlMs;
    this.#cleanupTimer = setInterval(() => this.#cleanup(), 60000);
  }

  create(userData) {
    const id = randomBytes(24).toString('hex');
    this.#sessions.set(id, {
      user: userData,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.#ttl,
    });
    return id;
  }

  get(id) {
    const s = this.#sessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.#sessions.delete(id);
      return null;
    }
    return s.user;
  }

  destroy(id) {
    this.#sessions.delete(id);
  }

  #cleanup() {
    const now = Date.now();
    for (const [id, s] of this.#sessions) {
      if (now > s.expiresAt) this.#sessions.delete(id);
    }
  }

  close() {
    clearInterval(this.#cleanupTimer);
  }

  get size() { return this.#sessions.size; }
}
