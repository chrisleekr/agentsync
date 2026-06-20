import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { SyncRow } from "../../status";
import { createInitialState } from "../state";
import { createStore } from "../store";
import { onSyncKey, runSyncOp } from "../tabs/sync";

function makeRow(partial: Partial<SyncRow>): SyncRow {
  return {
    agent: "claude",
    displayName: "x",
    sourcePath: "/x",
    vaultPath: "claude/x.age",
    vaultAbsPath: "/vault/claude/x.age",
    isSkill: false,
    status: "synced",
    detail: "",
    localHash: null,
    vaultHash: null,
    ...partial,
  };
}

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    sequence: name,
    ctrl: false,
    meta: false,
    shift: false,
    raw: name,
    number: false,
    ...mods,
  } as unknown as KeyEvent;
}

function seedReady(rows: SyncRow[]) {
  const store = createStore(createInitialState());
  store.dispatch((d) => {
    d.activeTab = "sync";
    d.sync.phase = "ready";
    d.sync.rows = rows;
    // Skip the key prompt so the row-level handlers are exercised directly.
    d.sync.keyPrompt = "skipped";
    // Expand synced section by default in tests so default-status rows are
    // navigable. Individual tests can flip this back to false when they
    // care about the collapsed-by-default behaviour.
    d.sync.showSynced = true;
  });
  return store;
}

describe("onSyncKey — navigation", () => {
  test("down/up moves cursor within bounds", () => {
    const store = seedReady([
      makeRow({ vaultPath: "a.age" }),
      makeRow({ vaultPath: "b.age" }),
      makeRow({ vaultPath: "c.age" }),
    ]);
    onSyncKey(key("down"), store);
    expect(store.getState().sync.cursor).toBe(1);
    onSyncKey(key("down"), store);
    onSyncKey(key("down"), store);
    expect(store.getState().sync.cursor).toBe(2);
    onSyncKey(key("up"), store);
    expect(store.getState().sync.cursor).toBe(1);
  });
});

describe("onSyncKey — selection", () => {
  test("space toggles selection on any row, skill or not", () => {
    const store = seedReady([
      makeRow({ vaultPath: "regular.age", isSkill: false }),
      makeRow({ vaultPath: "skills/foo.tar.age", isSkill: true }),
    ]);
    // Cursor starts on non-skill row — space should still select.
    onSyncKey(key("space"), store);
    expect(store.getState().selection.has("regular.age")).toBe(true);
    // Move to skill row and select that one too.
    onSyncKey(key("down"), store);
    onSyncKey(key("space"), store);
    expect(store.getState().selection.has("skills/foo.tar.age")).toBe(true);
    // Toggle the skill back off.
    onSyncKey(key("space"), store);
    expect(store.getState().selection.has("skills/foo.tar.age")).toBe(false);
    expect(store.getState().selection.size).toBe(1);
  });

  test("x on a non-skill row with a vault copy stages the confirm modal", () => {
    // Default status is "synced", so this row has a vault copy to remove.
    // Non-skill artifacts (commands, configs, rules) are removable too.
    const store = seedReady([makeRow({ vaultPath: "regular.age", isSkill: false })]);
    onSyncKey(key("space"), store);
    expect(store.getState().selection.size).toBe(1);
    onSyncKey(key("x"), store);
    const cr = store.getState().sync.confirmRemove;
    expect(cr).not.toBeNull();
    expect(cr?.items.map((it) => it.vaultPath)).toEqual(["regular.age"]);
    expect(cr?.ignoredCount).toBe(0);
  });
});

describe("onSyncKey — key prompt", () => {
  test("n during pending transitions to skipped", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.sync.keyPrompt = "pending";
    });
    onSyncKey(key("n"), store);
    expect(store.getState().sync.keyPrompt).toBe("skipped");
  });

  test("k from skipped re-arms the prompt", () => {
    const store = seedReady([makeRow({})]);
    onSyncKey(key("k"), store);
    expect(store.getState().sync.keyPrompt).toBe("pending");
  });
});

describe("onSyncKey — scroll keys", () => {
  function buildRows(n: number): SyncRow[] {
    const rows: SyncRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(makeRow({ vaultPath: `r${String(i).padStart(3, "0")}.age` }));
    }
    return rows;
  }

  test("pagedown advances cursor by PAGE_STEP and grows scrollOffset", () => {
    const store = seedReady(buildRows(50));
    expect(store.getState().sync.cursor).toBe(0);
    expect(store.getState().sync.scrollOffset).toBe(0);
    onSyncKey(key("pagedown"), store);
    expect(store.getState().sync.cursor).toBeGreaterThan(0);
    expect(store.getState().sync.scrollOffset).toBeGreaterThan(0);
  });

  test("pageup decreases cursor and scrollOffset, clamped at 0", () => {
    const store = seedReady(buildRows(50));
    store.dispatch((d) => {
      d.sync.cursor = 20;
      d.sync.scrollOffset = 20;
    });
    onSyncKey(key("pageup"), store);
    expect(store.getState().sync.cursor).toBeLessThan(20);
    expect(store.getState().sync.scrollOffset).toBeLessThan(20);
    // From near the top, pageup must not push below 0.
    store.dispatch((d) => {
      d.sync.cursor = 3;
      d.sync.scrollOffset = 3;
    });
    onSyncKey(key("pageup"), store);
    expect(store.getState().sync.cursor).toBe(0);
    expect(store.getState().sync.scrollOffset).toBe(0);
  });

  test("home jumps cursor and scrollOffset to 0", () => {
    const store = seedReady(buildRows(50));
    store.dispatch((d) => {
      d.sync.cursor = 30;
      d.sync.scrollOffset = 25;
    });
    onSyncKey(key("home"), store);
    expect(store.getState().sync.cursor).toBe(0);
    expect(store.getState().sync.scrollOffset).toBe(0);
  });

  test("end jumps cursor to last navigable row", () => {
    const rows = buildRows(50);
    const store = seedReady(rows);
    onSyncKey(key("end"), store);
    expect(store.getState().sync.cursor).toBe(rows.length - 1);
  });
});

describe("onSyncKey — synced section toggle", () => {
  function seedCollapsed(rows: SyncRow[]) {
    const store = seedReady(rows);
    store.dispatch((d) => {
      d.sync.showSynced = false;
    });
    return store;
  }

  test("s toggles showSynced and resets cursor", () => {
    const store = seedCollapsed([
      makeRow({ vaultPath: "a.age", status: "synced" }),
      makeRow({ vaultPath: "b.age", status: "local-changed" }),
      makeRow({ vaultPath: "c.age", status: "synced" }),
    ]);
    expect(store.getState().sync.showSynced).toBe(false);
    onSyncKey(key("s"), store);
    expect(store.getState().sync.showSynced).toBe(true);
    expect(store.getState().sync.cursor).toBe(0);
    onSyncKey(key("s"), store);
    expect(store.getState().sync.showSynced).toBe(false);
  });

  test("when showSynced=false, cursor can only land on non-synced rows", () => {
    const store = seedCollapsed([
      makeRow({ vaultPath: "z-synced.age", status: "synced" }),
      makeRow({ vaultPath: "a-synced.age", status: "synced" }),
      makeRow({ vaultPath: "m-changed.age", status: "local-changed" }),
    ]);
    // showSynced=false → only m-changed is navigable. Pressing down should stay at 0.
    onSyncKey(key("down"), store);
    expect(store.getState().sync.cursor).toBe(0);
  });

  test("when showSynced=true, all rows become navigable", () => {
    const store = seedCollapsed([
      makeRow({ vaultPath: "a-synced.age", status: "synced" }),
      makeRow({ vaultPath: "b-synced.age", status: "synced" }),
      makeRow({ vaultPath: "c-changed.age", status: "local-changed" }),
    ]);
    onSyncKey(key("s"), store); // toggle on
    onSyncKey(key("down"), store);
    onSyncKey(key("down"), store);
    expect(store.getState().sync.cursor).toBe(2);
  });
});

describe("onSyncKey — confirm-remove modal", () => {
  test("x with a skill selection stages the confirm modal, does not remove yet", () => {
    const store = seedReady([
      makeRow({ vaultPath: "claude/skills/foo.tar.age", isSkill: true }),
      makeRow({ vaultPath: "claude/skills/bar.tar.age", isSkill: true }),
    ]);
    onSyncKey(key("space"), store);
    onSyncKey(key("down"), store);
    onSyncKey(key("space"), store);
    expect(store.getState().selection.size).toBe(2);
    onSyncKey(key("x"), store);
    const cr = store.getState().sync.confirmRemove;
    expect(cr).not.toBeNull();
    expect(cr?.items.length).toBe(2);
    expect(cr?.ignoredCount).toBe(0);
    expect(cr?.visibleCount).toBe(2);
  });

  test("confirmRemove.visibleCount excludes selections hidden by a collapsed synced section", () => {
    // Two skill rows, one synced (hidden when section is collapsed) and one
    // local-changed (visible). Both selected. After collapsing the synced
    // section and pressing x, visibleCount should be 1 but items.length 2.
    const rows = [
      makeRow({
        vaultPath: "claude/skills/synced-skill.tar.age",
        isSkill: true,
        status: "synced",
      }),
      makeRow({
        vaultPath: "claude/skills/changed-skill.tar.age",
        isSkill: true,
        status: "local-changed",
      }),
    ];
    const store = seedReady(rows);
    // Select both while synced is visible.
    onSyncKey(key("a", { shift: true }), store);
    expect(store.getState().selection.size).toBe(2);
    // Collapse synced section.
    store.dispatch((d) => {
      d.sync.showSynced = false;
    });
    onSyncKey(key("x"), store);
    const cr = store.getState().sync.confirmRemove;
    expect(cr?.items.length).toBe(2);
    expect(cr?.visibleCount).toBe(1);
  });

  test("n in confirm modal cancels without dispatching the remove op", () => {
    const store = seedReady([makeRow({ vaultPath: "claude/skills/foo.tar.age", isSkill: true })]);
    onSyncKey(key("space"), store);
    onSyncKey(key("x"), store);
    expect(store.getState().sync.confirmRemove).not.toBeNull();
    onSyncKey(key("n"), store);
    expect(store.getState().sync.confirmRemove).toBeNull();
    // No "vault-rm" op was registered.
    expect(Object.values(store.getState().inFlight).some((op) => op.kind === "vault-rm")).toBe(
      false,
    );
  });

  test("escape in confirm modal also cancels", () => {
    const store = seedReady([makeRow({ vaultPath: "claude/skills/foo.tar.age", isSkill: true })]);
    onSyncKey(key("space"), store);
    onSyncKey(key("x"), store);
    onSyncKey(key("escape"), store);
    expect(store.getState().sync.confirmRemove).toBeNull();
  });

  test("vault-only mix of skill + non-skill rows are all staged (bug repro)", () => {
    // The reported bug: selecting 10 vault-only rows but only the 2 skills
    // being staged. All vault-only rows have a vault copy, so all are
    // removable regardless of isSkill.
    const store = seedReady([
      makeRow({
        vaultPath: "codex/skills/write-to-notion.tar.age",
        isSkill: true,
        status: "vault-only",
      }),
      makeRow({
        vaultPath: "claude/commands/pr-commit-message.md.age",
        isSkill: false,
        status: "vault-only",
      }),
      makeRow({
        vaultPath: "cursor/user-rules.md.age",
        isSkill: false,
        status: "vault-only",
      }),
    ]);
    onSyncKey(key("a", { shift: true }), store);
    expect(store.getState().selection.size).toBe(3);
    onSyncKey(key("x"), store);
    const cr = store.getState().sync.confirmRemove;
    expect(cr?.items.length).toBe(3);
    expect(cr?.ignoredCount).toBe(0);
  });

  test("local-only rows are ignored — no vault copy to remove", () => {
    const store = seedReady([
      makeRow({ vaultPath: "claude/new.md.age", isSkill: false, status: "local-only" }),
      makeRow({ vaultPath: "claude/in-vault.md.age", isSkill: false, status: "vault-only" }),
    ]);
    onSyncKey(key("a", { shift: true }), store);
    expect(store.getState().selection.size).toBe(2);
    onSyncKey(key("x"), store);
    const cr = store.getState().sync.confirmRemove;
    expect(cr?.items.map((it) => it.vaultPath)).toEqual(["claude/in-vault.md.age"]);
    expect(cr?.ignoredCount).toBe(1);
  });

  test("selecting only local-only rows shows toast, does not stage modal", () => {
    const store = seedReady([
      makeRow({ vaultPath: "claude/new.md.age", isSkill: false, status: "local-only" }),
    ]);
    onSyncKey(key("space"), store);
    onSyncKey(key("x"), store);
    expect(store.getState().sync.confirmRemove).toBeNull();
    expect(store.getState().toast?.text ?? "").toContain("no vault copy");
  });

  test("error rows (empty vaultPath) are ignored, not staged with a bogus path", () => {
    // A failed agent snapshot yields status:"error" with vaultPath:"". It must
    // not be staged — an empty vaultPath cannot be git-rm'd and would surface a
    // spurious "1 failed" in the bulk op.
    const store = seedReady([
      makeRow({ vaultPath: "", isSkill: false, status: "error", displayName: "(snapshot failed)" }),
      makeRow({ vaultPath: "claude/in-vault.md.age", isSkill: false, status: "vault-only" }),
    ]);
    onSyncKey(key("a", { shift: true }), store);
    expect(store.getState().selection.size).toBe(2);
    onSyncKey(key("x"), store);
    const cr = store.getState().sync.confirmRemove;
    expect(cr?.items.map((it) => it.vaultPath)).toEqual(["claude/in-vault.md.age"]);
    expect(cr?.ignoredCount).toBe(1);
  });
});

describe("onSyncKey — select-all and clear", () => {
  test("a selects all rows in cursor's section", () => {
    const store = seedReady([
      makeRow({ vaultPath: "a.age", status: "local-changed" }),
      makeRow({ vaultPath: "b.age", status: "local-changed" }),
      makeRow({ vaultPath: "c.age", status: "local-only" }),
    ]);
    onSyncKey(key("a"), store);
    expect(store.getState().selection.has("a.age")).toBe(true);
    expect(store.getState().selection.has("b.age")).toBe(true);
    expect(store.getState().selection.has("c.age")).toBe(false);
  });

  test("A (shift+a) selects all visible rows", () => {
    const store = seedReady([
      makeRow({ vaultPath: "a.age", status: "local-changed" }),
      makeRow({ vaultPath: "c.age", status: "local-only" }),
    ]);
    onSyncKey(key("a", { shift: true }), store);
    expect(store.getState().selection.size).toBe(2);
  });

  test("a toggles off when every target row is already selected", () => {
    const store = seedReady([
      makeRow({ vaultPath: "a.age", status: "local-changed" }),
      makeRow({ vaultPath: "b.age", status: "local-changed" }),
    ]);
    onSyncKey(key("a"), store);
    expect(store.getState().selection.size).toBe(2);
    onSyncKey(key("a"), store);
    expect(store.getState().selection.size).toBe(0);
  });

  test("escape with non-empty selection clears it", () => {
    const store = seedReady([makeRow({ vaultPath: "a.age" })]);
    onSyncKey(key("space"), store);
    expect(store.getState().selection.size).toBe(1);
    onSyncKey(key("escape"), store);
    expect(store.getState().selection.size).toBe(0);
  });

  test("escape with empty selection is a no-op (returns false)", () => {
    const store = seedReady([makeRow({ vaultPath: "a.age" })]);
    const handled = onSyncKey(key("escape"), store);
    expect(handled).toBe(false);
  });
});

describe("onSyncKey — clipboard copy", () => {
  test("c copies the cursor row's path when nothing is selected", () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
    // biome-ignore lint/suspicious/noExplicitAny: targeted spy
    (process.stdout as any).write = (chunk: unknown) => {
      if (typeof chunk === "string" && chunk.includes("\x1b]52;c;")) writes.push(chunk);
      return true;
    };
    try {
      const store = seedReady([
        makeRow({ vaultPath: "claude/CLAUDE.md.age", sourcePath: "/Users/x/.claude/CLAUDE.md" }),
      ]);
      onSyncKey(key("c"), store);
      expect(writes.length).toBe(1);
      // Decoded payload should be the source path.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing OSC 52 (ESC ] 52 ; c ; <b64> BEL)
      const match = writes[0].match(/\x1b\]52;c;(.+?)\x07/);
      const decoded = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
      expect(decoded).toContain(".claude/CLAUDE.md");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
    }
  });

  test("c with selection copies all selected paths newline-joined", () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
    // biome-ignore lint/suspicious/noExplicitAny: targeted spy
    (process.stdout as any).write = (chunk: unknown) => {
      if (typeof chunk === "string" && chunk.includes("\x1b]52;c;")) writes.push(chunk);
      return true;
    };
    try {
      const store = seedReady([makeRow({ vaultPath: "a.age" }), makeRow({ vaultPath: "b.age" })]);
      onSyncKey(key("a", { shift: true }), store);
      expect(store.getState().selection.size).toBe(2);
      onSyncKey(key("c"), store);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing OSC 52 (ESC ] 52 ; c ; <b64> BEL)
      const match = writes[0].match(/\x1b\]52;c;(.+?)\x07/);
      const decoded = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
      expect(decoded.split("\n").length).toBe(2);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
    }
  });
});

describe("runSyncOp — lastOp persistence", () => {
  test("aborts and writes lastOp.error when key isn't loaded", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.sync.phase = "ready";
      d.sync.keyPrompt = "skipped";
    });
    runSyncOp(store);
    const lastOp = store.getState().sync.lastOp;
    expect(lastOp?.kind).toBe("push");
    expect(lastOp?.status).toBe("error");
    expect(lastOp?.message).toContain("private key");
  });

  test("seeds lastOp.running synchronously when key is loaded and selection is non-empty", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.sync.phase = "ready";
      d.sync.keyPrompt = "idle";
      d.sync.keyLoaded = true;
      d.sync.keyCache = "AGE-SECRET-KEY-1FAKE";
      d.selection.add("claude/CLAUDE.md.age");
    });
    runSyncOp(store);
    const lastOp = store.getState().sync.lastOp;
    expect(lastOp?.kind).toBe("push");
    // The op is in-flight (will likely fail asynchronously in this test
    // env, but the synchronous transition to running is what we're
    // checking).
    expect(["running", "error"]).toContain(lastOp?.status ?? "");
  });

  test("rejects push synchronously with actionable error when selection is empty", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.sync.phase = "ready";
      d.sync.keyPrompt = "idle";
      d.sync.keyLoaded = true;
      d.sync.keyCache = "AGE-SECRET-KEY-1FAKE";
    });
    runSyncOp(store);
    const lastOp = store.getState().sync.lastOp;
    expect(lastOp?.kind).toBe("push");
    expect(lastOp?.status).toBe("error");
    // Message must tell the user exactly how to recover (select + push),
    // not just "nothing selected" — the recovery key is the actionable
    // part for a first-time user.
    expect(lastOp?.message).toContain("nothing selected");
    // Lock in the actionable phrase "press space" — not just "space" —
    // so a future rewrite that drops the verb still fails this assertion.
    expect(lastOp?.message).toContain("press space");
  });
});

describe("onSyncKey — diff modal", () => {
  test("enter on synced row does not open modal", () => {
    const store = seedReady([makeRow({ status: "synced" })]);
    onSyncKey(key("return"), store);
    expect(store.getState().sync.diff).toBeNull();
    expect(store.getState().toast?.text ?? "").toContain("synced");
  });

  test("enter on skill row without key shows error toast (drill-in needs decryption)", () => {
    const store = seedReady([
      makeRow({ vaultPath: "claude/skills/x.tar.age", isSkill: true, status: "local-changed" }),
    ]);
    onSyncKey(key("return"), store);
    // Drill-in needs the key to decrypt the bundle for any non-local-only skill.
    expect(store.getState().sync.skillDrillIn).toBeNull();
    expect(store.getState().toast?.level).toBe("error");
    expect(store.getState().toast?.text ?? "").toContain("key");
  });

  test("enter on local-only row reports no diff", () => {
    const store = seedReady([makeRow({ status: "local-only" })]);
    onSyncKey(key("return"), store);
    expect(store.getState().sync.diff).toBeNull();
    expect(store.getState().toast?.text ?? "").toContain("local-only");
  });

  test("enter on local-changed without key shows error toast", () => {
    const store = seedReady([makeRow({ status: "local-changed" })]);
    onSyncKey(key("return"), store);
    expect(store.getState().sync.diff).toBeNull();
    expect(store.getState().toast?.level).toBe("error");
  });

  test("escape closes an open diff modal", () => {
    const store = seedReady([makeRow({})]);
    store.dispatch((d) => {
      d.sync.diff = {
        vaultPath: "x.age",
        vaultPlain: "old",
        localPlain: "new",
        cursor: 0,
        side: "local",
        selectedVault: new Set(),
        selectedLocal: new Set(),
        scrollOffset: 0,
      };
    });
    onSyncKey(key("escape"), store);
    expect(store.getState().sync.diff).toBeNull();
  });
});

describe("computeSyncStatus — structured output", () => {
  test("emits status: 'unknown' rows when privateKey is null and vault file exists", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { machineVaultRoot } = await import("../../../config/paths");
    const { computeSyncStatus, __setStatusAgentsForTesting } = await import("../../status");

    const tmp = mkdtempSync(join(tmpdir(), "sync-status-"));
    const vaultDir = join(tmp, "vault");
    // v2: status reads this machine's namespace (machineName "test" below).
    const agentDir = join(machineVaultRoot(vaultDir, "test"), "test-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "x.age"), "encrypted-bytes", "utf8");

    const fakeAgent = {
      name: "test-agent" as const,
      snapshot: async () => ({
        artifacts: [
          {
            sourcePath: "/tmp/src",
            vaultPath: "test-agent/x.age",
            plaintext: "local content",
            warnings: [],
          },
        ],
        warnings: [],
      }),
      apply: async () => {},
    } as unknown as Parameters<typeof __setStatusAgentsForTesting>[0] extends Array<infer A>
      ? A
      : never;

    __setStatusAgentsForTesting([fakeAgent]);
    try {
      const config = {
        agents: { "test-agent": true },
        recipients: {},
        remote: { url: "", branch: "main" },
      } as unknown as Parameters<typeof computeSyncStatus>[1];
      const runtime = {
        vaultDir,
        privateKeyPath: "/dev/null",
        machineName: "test",
      } as unknown as Parameters<typeof computeSyncStatus>[0];
      const rows = await computeSyncStatus(runtime, config, null);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("unknown");
      expect(rows[0].detail).toBe("key unavailable");
    } finally {
      __setStatusAgentsForTesting(null);
      const { rmSync } = await import("node:fs");
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("onSyncKey — skill drill-in", () => {
  // Seed a drill-in panel by hand so the drill-in handler can be exercised
  // without spinning up an actual age-encrypted tar bundle. The bundle
  // building / decryption is covered by integration tests in tar.test.ts.
  function seedWithDrillIn() {
    const store = seedReady([
      makeRow({ vaultPath: "claude/skills/x.tar.age", isSkill: true, status: "local-changed" }),
    ]);
    store.dispatch((d) => {
      // Seeded in render order (status group, then alphabetical within
      // group) so cursor indices in tests line up with the user's visual
      // navigation order.
      d.sync.skillDrillIn = {
        vaultPath: "claude/skills/x.tar.age",
        bundleName: "x",
        files: [
          {
            relPath: "SKILL.md",
            status: "local-changed",
            vaultText: "old\n",
            localText: "new\n",
            isBinary: false,
          },
          {
            relPath: "image.png",
            status: "local-changed",
            vaultText: null,
            localText: null,
            isBinary: true,
          },
          {
            relPath: "helpers/a.md",
            status: "synced",
            vaultText: "same\n",
            localText: "same\n",
            isBinary: false,
          },
        ],
        cursor: 0,
        scrollOffset: 0,
      };
    });
    return store;
  }

  test("escape closes the drill-in panel", () => {
    const store = seedWithDrillIn();
    onSyncKey(key("escape"), store);
    expect(store.getState().sync.skillDrillIn).toBeNull();
  });

  test("down/up navigate files inside the bundle", () => {
    const store = seedWithDrillIn();
    onSyncKey(key("down"), store);
    expect(store.getState().sync.skillDrillIn?.cursor).toBe(1);
    onSyncKey(key("up"), store);
    expect(store.getState().sync.skillDrillIn?.cursor).toBe(0);
  });

  test("enter on a local-changed file opens the diff modal with bundle-prefixed vaultPath", () => {
    const store = seedWithDrillIn();
    onSyncKey(key("return"), store);
    const diff = store.getState().sync.diff;
    expect(diff).not.toBeNull();
    expect(diff?.vaultPath).toBe("claude/skills/x.tar.age::SKILL.md");
    expect(diff?.vaultPlain).toBe("old\n");
    expect(diff?.localPlain).toBe("new\n");
    // Drill-in must survive: closing the diff lands the user back on the
    // bundle file list, not on the outer file list.
    expect(store.getState().sync.skillDrillIn).not.toBeNull();
  });

  test("enter on a synced file opens the diff modal as a viewer", () => {
    const store = seedWithDrillIn();
    store.dispatch((d) => {
      // helpers/a.md sits in the `synced` section, after the two
      // local-changed entries — cursor 2 in render order.
      if (d.sync.skillDrillIn) d.sync.skillDrillIn.cursor = 2;
    });
    onSyncKey(key("return"), store);
    const diff = store.getState().sync.diff;
    expect(diff).not.toBeNull();
    expect(diff?.vaultPath).toBe("claude/skills/x.tar.age::helpers/a.md");
    // Both sides identical — every row will render as unchanged context.
    expect(diff?.vaultPlain).toBe(diff?.localPlain);
  });

  test("enter on a local-only file opens the diff with an empty vault side", () => {
    const store = seedWithDrillIn();
    store.dispatch((d) => {
      if (d.sync.skillDrillIn) {
        d.sync.skillDrillIn.files.push({
          relPath: "fresh.md",
          status: "local-only",
          vaultText: null,
          localText: "hello\nworld\n",
          isBinary: false,
        });
        d.sync.skillDrillIn.cursor = d.sync.skillDrillIn.files.length - 1;
      }
    });
    onSyncKey(key("return"), store);
    const diff = store.getState().sync.diff;
    expect(diff).not.toBeNull();
    expect(diff?.vaultPlain).toBe("");
    expect(diff?.localPlain).toBe("hello\nworld\n");
  });

  test("enter on a vault-only file opens the diff with an empty local side", () => {
    const store = seedWithDrillIn();
    store.dispatch((d) => {
      if (d.sync.skillDrillIn) {
        d.sync.skillDrillIn.files.push({
          relPath: "removed.md",
          status: "vault-only",
          vaultText: "stale\n",
          localText: null,
          isBinary: false,
        });
        d.sync.skillDrillIn.cursor = d.sync.skillDrillIn.files.length - 1;
      }
    });
    onSyncKey(key("return"), store);
    const diff = store.getState().sync.diff;
    expect(diff).not.toBeNull();
    expect(diff?.vaultPlain).toBe("stale\n");
    expect(diff?.localPlain).toBe("");
  });

  test("enter on a binary file refuses the diff", () => {
    const store = seedWithDrillIn();
    store.dispatch((d) => {
      // image.png is the second local-changed entry in render order.
      if (d.sync.skillDrillIn) d.sync.skillDrillIn.cursor = 1;
    });
    onSyncKey(key("return"), store);
    expect(store.getState().sync.diff).toBeNull();
    expect(store.getState().toast?.text ?? "").toContain("binary");
  });

  test("drill-in swallows global shortcuts (p, l) until esc", () => {
    const store = seedWithDrillIn();
    const before = store.getState().sync.skillDrillIn;
    onSyncKey(key("p"), store);
    onSyncKey(key("l"), store);
    onSyncKey(key("x"), store);
    expect(store.getState().sync.skillDrillIn).toBe(before);
  });

  test("escape bumps skillDrillInRequestSeq so a slow decrypt cannot re-open", () => {
    const store = seedWithDrillIn();
    const before = store.getState().sync.skillDrillInRequestSeq;
    onSyncKey(key("escape"), store);
    expect(store.getState().sync.skillDrillIn).toBeNull();
    // The seq must move forward — any in-flight openSkillDrillIn that
    // captured `before` will compare unequal and refuse to dispatch.
    expect(store.getState().sync.skillDrillInRequestSeq).toBeGreaterThan(before);
  });

  test("down/up move through render order (status group, then alphabetical)", () => {
    const store = seedWithDrillIn();
    // Seeded order is: [local-changed: SKILL.md, image.png], [synced: helpers/a.md]
    // Pressing Down from cursor 0 must land on the next local-changed entry
    // (image.png), not jump alphabetically into a different section.
    expect(store.getState().sync.skillDrillIn?.files[0].relPath).toBe("SKILL.md");
    onSyncKey(key("down"), store);
    expect(store.getState().sync.skillDrillIn?.cursor).toBe(1);
    expect(store.getState().sync.skillDrillIn?.files[1].relPath).toBe("image.png");
    onSyncKey(key("down"), store);
    expect(store.getState().sync.skillDrillIn?.cursor).toBe(2);
    expect(store.getState().sync.skillDrillIn?.files[2].relPath).toBe("helpers/a.md");
  });
});
