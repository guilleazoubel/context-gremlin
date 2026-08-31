export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn, fn);
    // Store a tail that never rejects, so a prior failure never blocks
    // subsequent calls for the same key from running.
    const settledTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settledTail);
    // Prune the entry once this is the last queued call for the key, so
    // one-shot keys (invalid/nonexistent session ids) don't grow the map
    // without bound.
    void settledTail.then(() => {
      if (this.tails.get(key) === settledTail) {
        this.tails.delete(key);
      }
    });
    return result;
  }
}
