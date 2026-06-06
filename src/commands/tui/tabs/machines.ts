import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { listMachines, performCopy } from "../../copy";
import { resolveRuntimeContext } from "../../shared";
import { AGENTS, type AppState, setToast } from "../state";
import type { Store } from "../store";

/**
 * Load the machine namespaces under `vault/machines/` once per tab visit. Reuses
 * `listMachines` from the copy command so the enumeration never forks.
 */
export function ensureMachinesLoaded(store: Store): void {
  if (store.getState().machines.phase !== "idle") return;
  store.dispatch((d) => {
    d.machines.phase = "loading";
    d.machines.error = null;
  });
  store.runOperation(
    "machines-load",
    "load machines",
    async () => {
      const runtime = await resolveRuntimeContext();
      return listMachines(runtime.vaultDir);
    },
    {
      onSuccess: (d, list) => {
        d.machines.list = list;
        d.machines.cursor = Math.min(d.machines.cursor, Math.max(0, list.length - 1));
        d.machines.phase = "ready";
      },
      onError: (d, err) => {
        d.machines.phase = "error";
        d.machines.error = err.message;
      },
    },
  );
}

/** Copy every agent namespace of `machine` to local disk via the shared core. */
function copyMachine(store: Store, machine: string): void {
  store.runOperation(
    "copy",
    `copy ${machine}`,
    async () => {
      let applied = 0;
      for (const agent of AGENTS) {
        const result = await performCopy({ fromMachine: machine, vaultPath: `${agent}/` });
        if (result.status === "applied") applied += result.count;
        else if (result.status === "reconcile-error" || result.status === "error") {
          throw new Error(result.error);
        }
        // not-found (this machine has no artifacts for the agent) is expected — skip.
      }
      return applied;
    },
    {
      activityKind: "copy",
      toastOnStart: { text: `Copying ${machine}…` },
      onSuccess: (d, applied) => {
        setToast(d, `Copied ${applied} artifact(s) from ${machine}`, "success");
        d.machines.lastCopy = { machine, ok: true, message: `applied ${applied} artifact(s)` };
      },
      onError: (d, err) => {
        setToast(d, `Copy failed: ${err.message}`, "error");
        d.machines.lastCopy = { machine, ok: false, message: err.message };
      },
      errorToastPrefix: "copy",
    },
  );
}

/** Handle Machines-tab keys. Returns true when the key was consumed. */
export function onMachinesKey(key: KeyEvent, store: Store): boolean {
  const m = store.getState().machines;
  if (m.phase !== "ready" || m.list.length === 0) return false;

  if (key.name === "down") {
    store.dispatch((d) => {
      d.machines.cursor = Math.min(d.machines.cursor + 1, d.machines.list.length - 1);
    });
    return true;
  }
  if (key.name === "up") {
    store.dispatch((d) => {
      d.machines.cursor = Math.max(d.machines.cursor - 1, 0);
    });
    return true;
  }
  if (key.name === "return") {
    const machine = m.list[m.cursor];
    if (machine) copyMachine(store, machine);
    return true;
  }
  return false;
}

export function renderMachines(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const m = state.machines;
  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: "#11151a",
    border: false,
  });
  host.add(wrapper);

  let body: string;
  if (m.phase === "loading" || m.phase === "idle") {
    body = "\n  Loading machine namespaces…";
  } else if (m.phase === "error") {
    body = `\n  Failed to list machines: ${m.error ?? "unknown error"}`;
  } else if (m.list.length === 0) {
    body = "\n  No machines in the vault yet. Run `agentsync push` on a machine first.";
  } else {
    body = ["", ...m.list.map((name, i) => `  ${i === m.cursor ? "›" : " "} ${name}`), ""].join(
      "\n",
    );
  }

  const listBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Machines (vault namespaces) ",
    backgroundColor: "#11151a",
  });
  listBox.add(new TextRenderable(renderer, { content: body, fg: "#d8dee9", bg: "#11151a" }));
  wrapper.add(listBox);

  const last = m.lastCopy
    ? `  last: ${m.lastCopy.ok ? "✓" : "✗"} ${m.lastCopy.machine} — ${m.lastCopy.message}`
    : "  ↑↓ select • enter: copy the machine's config to this machine • copy never touches the vault";
  wrapper.add(
    new TextRenderable(renderer, {
      height: 2,
      width: "100%",
      fg: "#6c7886",
      bg: "#11151a",
      content: `\n${last}`,
    }),
  );
}
