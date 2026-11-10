/**
 * Unbounded single-consumer queue that is also an async iterable. Producers
 * `push` and finally `close`; the one consumer iterates with `for await`,
 * which ends after the remaining items once the queue is closed.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;
  #iterated = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Add an item. Returns `false` and drops it if the queue is closed. */
  push(item: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
    return true;
  }

  /** No more items. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterated) throw new Error('AsyncQueue can only be iterated once');
    this.#iterated = true;
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.close();
        this.#items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
