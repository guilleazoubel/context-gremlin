import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../../src/api/keyed-lock';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('KeyedLock', () => {
  it('runs calls for the same key strictly in order, one at a time', async () => {
    const lock = new KeyedLock();
    const order: number[] = [];
    const p1 = lock.withLock('a', async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = lock.withLock('a', async () => {
      await delay(1);
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('runs calls for different keys concurrently, not serialized', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const pA = lock.withLock('a', async () => {
      await delay(20);
      order.push('a');
    });
    const pB = lock.withLock('b', async () => {
      await delay(1);
      order.push('b');
    });
    await Promise.all([pA, pB]);
    expect(order).toEqual(['b', 'a']);
  });

  it('propagates the function result', async () => {
    const lock = new KeyedLock();
    const result = await lock.withLock('a', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates a thrown error to the caller', async () => {
    const lock = new KeyedLock();
    await expect(
      lock.withLock('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('continues processing subsequent calls after a prior call for the same key threw', async () => {
    const lock = new KeyedLock();
    const first = lock.withLock('a', async () => {
      throw new Error('boom');
    });
    const second = lock.withLock('a', async () => 'ok');
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });
});
