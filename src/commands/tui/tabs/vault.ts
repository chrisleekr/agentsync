import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { resolveRuntimeContext } from "../../shared";
import { performSkillRemove } from "../../skill";
import type { AppState, VaultEntry } from "../state";
import type { Store } from "../store";

async function loadEntries(): Promise<VaultEntry[]> {
  // Single source of truth for vault dir + key path resolution. Any future
  // env-var or config indirection lands in resolveRuntimeContext and this
  // loader picks it up for free.
  const { vaultDir } = await resolveRuntimeContext();
  const out: VaultEntry[] = [];

  async function walk(dir: string, relParts: string[]): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full, [...relParts, name]);
      } else if (info.isFile() && (name.endsWith(".age") || name.endsWith(".tar.age"))) {
        const agent = relParts[0] ?? "(root)";
        const rel = [...relParts, name].join("/");
        const isSkill = relParts.includes("skills");
        out.push({ agent, path: rel, absolutePath: full, size: info.size, isSkill });
      }
    }
  }

  await walk(vaultDir, []);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function renderVault(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const v = state.vault;

  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: "#11151a",
  });
  host.add(wrapper);

  const listBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Vault entries ",
    backgroundColor: "#11151a",
  });
  wrapper.add(listBox);

  if (v.phase === "error") {
    listBox.add(
      new TextRenderable(renderer, {
        content: `  Cannot list vault: ${v.error}\n  Run \`agentsync init\` first.`,
        fg: "#bf616a",
        bg: "#11151a",
      }),
    );
    return;
  }

  if (v.phase === "loading" || v.phase === "idle") {
    listBox.add(
      new TextRenderable(renderer, {
        content: "\n  Loading vault entries…",
        fg: "#6c7886",
        bg: "#11151a",
      }),
    );
    return;
  }

  if (v.entries.length === 0) {
    listBox.add(
      new TextRenderable(renderer, {
        content:
          "\n  Vault is empty (or daemon hasn't snapshotted yet).\n  Press p to push your local agent configs.",
        fg: "#6c7886",
        bg: "#11151a",
      }),
    );
    return;
  }

  const rows: string[] = [];
  let lastAgent = "";
  for (let i = 0; i < v.entries.length; i++) {
    const e = v.entries[i];
    if (e.agent !== lastAgent) {
      rows.push(`  ${e.agent}/`);
      lastAgent = e.agent;
    }
    const sel = state.selection.has(e.absolutePath) ? "[x]" : e.isSkill ? "[ ]" : "   ";
    const marker = i === v.cursor ? "▶" : " ";
    const size = e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(1)}K`;
    rows.push(`  ${marker} ${sel} ${e.path.padEnd(48)} ${size}`);
  }

  listBox.add(
    new TextRenderable(renderer, {
      content: rows.join("\n"),
      fg: "#d8dee9",
      bg: "#11151a",
    }),
  );
}

/** Kicks off a vault load via the store. No-op when already loading or ready. */
export function ensureVaultLoaded(store: Store): void {
  const v = store.getState().vault;
  if (v.phase === "loading" || v.phase === "ready") return;
  store.dispatch((d) => {
    d.vault.phase = "loading";
    d.vault.error = null;
  });
  store.runOperation("vault-load", "load vault entries", () => loadEntries(), {
    onSuccess: (draft, entries) => {
      const list = entries as VaultEntry[];
      draft.vault.entries = list;
      draft.vault.cursor = Math.min(draft.vault.cursor, Math.max(0, list.length - 1));
      draft.vault.phase = "ready";
      draft.vault.error = null;
    },
    onError: (draft, err) => {
      draft.vault.phase = "error";
      draft.vault.error = err.message;
    },
  });
}

export function onVaultKey(key: KeyEvent, store: Store): boolean {
  const state = store.getState();
  const v = state.vault;
  if (v.entries.length === 0) return false;

  if (key.name === "up") {
    store.dispatch((d) => {
      d.vault.cursor = Math.max(0, d.vault.cursor - 1);
    });
    return true;
  }
  if (key.name === "down") {
    store.dispatch((d) => {
      d.vault.cursor = Math.min(d.vault.entries.length - 1, d.vault.cursor + 1);
    });
    return true;
  }
  if (key.name === "space") {
    const cur = v.entries[v.cursor];
    if (cur?.isSkill) {
      store.dispatch((d) => {
        if (d.selection.has(cur.absolutePath)) d.selection.delete(cur.absolutePath);
        else d.selection.add(cur.absolutePath);
      });
      return true;
    }
    return false;
  }
  if (key.name === "x" && state.selection.size > 0) {
    runBulkSkillRemove(store);
    return true;
  }
  return false;
}

function runBulkSkillRemove(store: Store): void {
  const state = store.getState();
  // The walker already carries `agent` and the relative vault path on
  // VaultEntry. Looking the entry up by `absolutePath` keeps removal honest
  // even if the vault subtree layout changes (e.g. nested plugin skills),
  // and avoids hand-rolled path slicing that would mis-attribute a deletion.
  const byAbs = new Map(state.vault.entries.map((e) => [e.absolutePath, e]));
  const items: { agent: string; name: string }[] = [];
  for (const abs of state.selection) {
    const entry = byAbs.get(abs);
    if (!entry?.isSkill) continue;
    const fileName = entry.path.split("/").pop() ?? "";
    const name = fileName.replace(/\.tar\.age$/, "");
    if (entry.agent && name) items.push({ agent: entry.agent, name });
  }
  if (items.length === 0) return;

  store.runOperation(
    "skill-rm",
    `remove ${items.length} skill(s)`,
    async () => {
      let ok = 0;
      let fail = 0;
      for (const item of items) {
        const r = await performSkillRemove(item);
        if (r.status === "success") ok++;
        else fail++;
      }
      return { ok, fail };
    },
    {
      activityKind: "skill-rm",
      onSuccess: (draft, result) => {
        const { ok, fail } = result as { ok: number; fail: number };
        draft.selection.clear();
        draft.vault.phase = "idle";
        const text = `Removed ${ok} skill(s)${fail > 0 ? `, ${fail} failed` : ""}`;
        draft.toast = {
          text,
          level: fail === 0 ? "success" : "error",
          expiresAt: Date.now() + 3000,
        };
      },
    },
  );
}
