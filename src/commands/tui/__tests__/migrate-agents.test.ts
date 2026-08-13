import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { AgentPaths } from "../../../config/paths";
import { createInitialState } from "../state";
import { createStore, type Store } from "../store";
import { onMigrateKey } from "../tabs/migrate";

const paths = AgentPaths as unknown as Record<string, Record<string, string>>;
let root: string;
let original: Record<string, Record<string, string>>;

function key(name: string): KeyEvent {
  return {
    name,
    sequence: name,
    ctrl: false,
    meta: false,
    shift: false,
    raw: name,
    number: false,
  } as unknown as KeyEvent;
}

async function waitForOperation(store: Store, kind: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const operation = Object.values(store.getState().inFlight).find((item) => item.kind === kind);
    if (operation && operation.phase !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${kind}`);
}

beforeEach(() => {
  root = join(tmpdir(), `agents-tui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  original = structuredClone(paths);
  paths.claude.agentsDir = join(root, "claude");
  paths.copilot.agentsDir = join(root, "shared");
  paths.vscode.agentsDir = paths.copilot.agentsDir;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [agent, values] of Object.entries(original)) Object.assign(paths[agent], values);
});

test("TUI preview and apply deduplicate selected Copilot and VS Code agent targets", async () => {
  const source = join(paths.claude.agentsDir, "reviewer.md");
  const destination = join(paths.copilot.agentsDir, "reviewer.agent.md");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "---\nname: reviewer\ndescription: Reviews\n---\n\nReview.");
  const store = createStore(createInitialState());

  try {
    store.dispatch((draft) => {
      draft.migrate.from = "claude";
      draft.migrate.toSet = new Set(["copilot", "vscode"]);
      draft.migrate.typeSet = new Set(["agents"]);
      draft.migrate.field = "preview";
    });
    onMigrateKey(key("return"), store);
    await waitForOperation(store, "migrate-preview");

    const preview = store.getState().migrate.preview;
    expect(preview.split(destination)).toHaveLength(2);
    expect(preview).not.toContain("  ! ");
    expect(await Bun.file(destination).exists()).toBe(false);

    store.dispatch((draft) => {
      draft.migrate.field = "apply";
    });
    onMigrateKey(key("return"), store);
    await waitForOperation(store, "migrate");

    expect(store.getState().toast?.level).toBe("success");
    expect(await readdir(paths.copilot.agentsDir)).toEqual(["reviewer.agent.md"]);
    expect(await Bun.file(destination).text()).not.toContain("target:");
  } finally {
    store.dispose();
  }
});
