/**
 * src/core/watcher.ts
 *
 * Wraps Bun's `fs.watch` with per-path debouncing so that rapid successive saves
 * (e.g. editor swap files) are collapsed into a single callback invocation.
 */

/** Debounced callback invoked after a watched path settles. */
export type WatchCallback = (path: string) => void | Promise<void>;

// Use the Node.js `fs.watch` via Bun's Node compat layer — Bun also exposes
// `Bun.watch` but `fs.watch` is more portable and well-tested.
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";

interface WatchedPath {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/** Track file-system watchers and collapse rapid save bursts into single callbacks. */
export class Watcher {
  private readonly watching = new Map<string, WatchedPath>();

  /**
   * Start watching a file or directory.
   *
   * @param filePath    Absolute path to watch.
   * @param debounceMs  Minimum quiet period before firing the callback (default: 300 ms).
   * @param callback    Called with the affected path after the debounce window closes.
   */
  add(filePath: string, debounceMs: number, callback: WatchCallback): void {
    if (this.watching.has(filePath)) return;

    // Create the entry first so the watcher callback can update it by reference,
    // ensuring remove() always sees the current timer and can cancel it.
    const entry: WatchedPath = { watcher: null as unknown as FSWatcher, debounceTimer: null };

    const watcher = watch(filePath, { recursive: true }, (_event, filename) => {
      const changedPath = filename ? join(filePath, filename) : filePath;

      if (entry.debounceTimer !== null) {
        clearTimeout(entry.debounceTimer);
      }

      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        void Promise.resolve(callback(changedPath));
      }, debounceMs);
    });

    entry.watcher = watcher;
    this.watching.set(filePath, entry);
  }

  /**
   * Stop watching a specific path. Cancels any pending debounce timer.
   */
  remove(filePath: string): void {
    const entry = this.watching.get(filePath);
    if (!entry) return;
    entry.watcher.close();
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    this.watching.delete(filePath);
  }

  /**
   * Stop all watchers.
   */
  close(): void {
    for (const filePath of this.watching.keys()) {
      this.remove(filePath);
    }
  }
}
