/**
 * A promise-chain queue that serialises async operations so only one executes at a time.
 *
 * Callers enqueue functions that return promises; each function waits for the previous
 * one to settle (resolve or reject) before it starts. No external dependencies are required.
 */
export class SyncQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Enqueue `fn`; it will run only after any currently-running operation settles.
   * @returns A promise that resolves or rejects with the result of `fn`.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Advance the tail, swallowing errors so a failed operation
    // does not block subsequent enqueued work.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Returns a promise that resolves once all currently-queued operations have settled.
   * Safe to call at any time — resolves immediately if the queue is already idle.
   */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}
