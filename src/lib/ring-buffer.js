export class RingBuffer {
  #buf;
  #cap;
  #head = 0;
  #size = 0;

  constructor(capacity) {
    this.#cap = capacity;
    this.#buf = new Array(capacity);
  }

  push(item) {
    this.#buf[this.#head] = item;
    this.#head = (this.#head + 1) % this.#cap;
    if (this.#size < this.#cap) this.#size++;
  }

  toArray() {
    if (this.#size === 0) return [];
    if (this.#size < this.#cap) return this.#buf.slice(0, this.#size);
    return [...this.#buf.slice(this.#head), ...this.#buf.slice(0, this.#head)];
  }

  last() {
    if (this.#size === 0) return undefined;
    return this.#buf[(this.#head - 1 + this.#cap) % this.#cap];
  }

  get length() { return this.#size; }
  get capacity() { return this.#cap; }

  clear() {
    this.#head = 0;
    this.#size = 0;
  }
}
