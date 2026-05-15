import {
  type AppState,
  type OperationStatus,
  type OpKind,
  type OpPhase,
  pushActivity,
  setToast,
} from "./state";

export type Mutator = (draft: AppState) => void;
export type Subscriber = () => void;

export interface RunOpOptions<R> {
  meta?: Record<string, unknown>;
  toastOnStart?: { text: string; level?: "info" | "success" | "error" } | null;
  onSuccess?: (draft: AppState, result: R) => void;
  onError?: (draft: AppState, err: Error) => void;
  /** When set, the terminal phase pushes an ActivityEntry with this kind. */
  activityKind?: "push" | "pull" | "skill-rm" | "migrate" | "preview" | "info";
  /** Override the terminal toast text; defaults to label + outcome. */
  successToast?: string;
  errorToastPrefix?: string;
  /** Eviction delay for the inFlight slot once terminal. Default 2000ms. */
  evictAfterMs?: number;
}

export interface Store {
  getState(): Readonly<AppState>;
  dispatch(mutator: Mutator): void;
  subscribe(fn: Subscriber): () => void;
  runOperation<R>(
    kind: OpKind,
    label: string,
    opFn: () => Promise<R>,
    opts?: RunOpOptions<R>,
  ): string;
  /**
   * Marks the store closed. Pending eviction timers become no-ops, in-flight
   * `opFn` results are dropped, and `dispatch` becomes a no-op. Idempotent.
   */
  dispose(): void;
}

const DEFAULT_EVICT_MS = 2000;

export function createStore(initial: AppState): Store {
  const state = initial;
  const subscribers = new Set<Subscriber>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;

  function notify(): void {
    if (closed) return;
    for (const s of subscribers) s();
  }

  function dispatch(mutator: Mutator): void {
    if (closed) return;
    mutator(state);
    notify();
  }

  function newOpId(): string {
    state.opSeq += 1;
    return `op-${state.opSeq}`;
  }

  function setPhase(id: string, phase: OpPhase, error: string | null): void {
    const op = state.inFlight[id];
    if (!op) return;
    op.phase = phase;
    op.error = error;
    op.finishedAt = Date.now();
  }

  function runOperation<R>(
    kind: OpKind,
    label: string,
    opFn: () => Promise<R>,
    opts: RunOpOptions<R> = {},
  ): string {
    const id = newOpId();
    const startedAt = Date.now();
    const op: OperationStatus = {
      id,
      kind,
      label,
      startedAt,
      finishedAt: null,
      phase: "running",
      error: null,
      meta: opts.meta ?? {},
    };

    dispatch((draft) => {
      draft.inFlight[id] = op;
      if (opts.toastOnStart) {
        setToast(draft, opts.toastOnStart.text, opts.toastOnStart.level ?? "info");
      }
      if (opts.activityKind) {
        pushActivity(draft, {
          kind: opts.activityKind,
          status: "running",
          message: label,
        });
      }
    });

    void (async () => {
      try {
        const result = await opFn();
        dispatch((draft) => {
          setPhase(id, "ok", null);
          opts.onSuccess?.(draft, result);
          if (opts.activityKind) {
            pushActivity(draft, {
              kind: opts.activityKind,
              status: "ok",
              message: opts.successToast ?? `${label} ok`,
            });
          }
          if (opts.successToast) setToast(draft, opts.successToast, "success");
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dispatch((draft) => {
          setPhase(id, "error", message);
          opts.onError?.(draft, err instanceof Error ? err : new Error(message));
          if (opts.activityKind) {
            pushActivity(draft, {
              kind: opts.activityKind,
              status: "fail",
              message: `${label}: ${message}`,
            });
          }
          const prefix = opts.errorToastPrefix ?? label;
          setToast(draft, `${prefix} failed: ${message}`, "error");
        });
      } finally {
        if (!closed) {
          const ms = opts.evictAfterMs ?? DEFAULT_EVICT_MS;
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            dispatch((draft) => {
              delete draft.inFlight[id];
            });
          }, ms);
          pendingTimers.add(timer);
        }
      }
    })();

    return id;
  }

  function dispose(): void {
    if (closed) return;
    closed = true;
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    subscribers.clear();
  }

  return {
    getState: () => state,
    dispatch,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    runOperation,
    dispose,
  };
}
