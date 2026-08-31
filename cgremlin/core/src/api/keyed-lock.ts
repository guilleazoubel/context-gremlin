export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn, fn);
    // Store a tail that never rejects, so a prior failure never blocks
    // subsequent calls for the same key from running.
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
