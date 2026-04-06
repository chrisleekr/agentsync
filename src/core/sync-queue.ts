/**
 * A promise-chain queue that serialises async operations so only one executes at a time.
 *
 * Callers enqueue functions that return promises; each function waits for the previous
 * one to settle (resolve or reject) before it starts. No external dependencies are required.
 */
export class SyncQueue {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  /**
   * Permanently stop accepting new work. Already-enqueued operations continue
   * to completion. Subsequent `enqueue()` calls reject immediately.
   *
   * Intended for use during daemon shutdown — call after `ipc.close()` and
   * before `whenIdle()` to prevent watcher callbacks from adding new work.
   */
  close(): void {
    this.accepting = false;
  }

  /**
   * Enqueue `fn`; it will run only after any currently-running operation settles.
   * @returns A promise that resolves or rejects with the result of `fn`.
   * @throws {Error} If the queue has been closed via `close()`.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("SyncQueue is closed"));
    }
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
