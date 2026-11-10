import { describe, expect, it } from 'vitest';

import { AsyncQueue } from './async-queue.js';

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) items.push(item);
  return items;
}

describe('AsyncQueue', () => {
  it('delivers items pushed before and after the consumer starts', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const result = drain(queue);
    queue.push(2);
    await Promise.resolve();
    queue.push(3);
    queue.close();
    expect(await result).toEqual([1, 2, 3]);
  });

  it('drops items pushed after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    expect(queue.push(1)).toBe(false);
    expect(await drain(queue)).toEqual([]);
  });

  it('can only be iterated once', () => {
    const queue = new AsyncQueue<number>();
    queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrow(/once/);
  });

  it('closes when the consumer breaks out', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    for await (const _item of queue) break;
    expect(queue.closed).toBe(true);
  });
});
