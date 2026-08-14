import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encryptString, generateIdentity, identityToRecipient } from "../../core/encryptor";
import {
  type ApplyPlan,
  defineFileArtifact,
  dirWriteApplier,
  makeApplyVault,
  readAgeFiles,
  runApplyPlan,
  skillNameFilter,
} from "../_apply";

let workDir = "";
let identity = "";
let recipient = "";

async function setupKey(): Promise<void> {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
}

async function writeEncrypted(absPath: string, plaintext: string): Promise<void> {
  mkdirSync(dirname(absPath), { recursive: true });
  const armored = await encryptString(plaintext, [recipient]);
  writeFileSync(absPath, armored, "utf8");
}

beforeEach(async () => {
  workDir = join(tmpdir(), `agentsync-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  await setupKey();
});

afterEach(() => {
  // Best-effort cleanup; OS temp will reclaim if this fails.
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("readAgeFiles", () => {
  test("returns empty for a missing directory", async () => {
    const out = await readAgeFiles(join(workDir, "missing"));
    expect(out).toEqual([]);
  });

  test("filters non-matching suffixes", async () => {
    writeFileSync(join(workDir, "a.age"), "x");
    writeFileSync(join(workDir, "b.txt"), "y");
    writeFileSync(join(workDir, "c.tar.age"), "z");
    const ageOnly = await readAgeFiles(workDir, ".age");
    expect(ageOnly.map((f) => f.name).sort()).toEqual(["a.age", "c.tar.age"]);
    const tarOnly = await readAgeFiles(workDir, ".tar.age");
    expect(tarOnly.map((f) => f.name)).toEqual(["c.tar.age"]);
  });

  test("preserves sorted relative paths when recursive discovery is enabled", async () => {
    mkdirSync(join(workDir, "nested", "deep"), { recursive: true });
    writeFileSync(join(workDir, "root.age"), "root");
    writeFileSync(join(workDir, "nested", "deep", "child.age"), "child");
    expect((await readAgeFiles(workDir, ".age", true)).map((file) => file.name)).toEqual([
      "nested/deep/child.age",
      "root.age",
    ]);
  });
});

describe("runApplyPlan FileArtifact", () => {
  test("decrypts and invokes apply for a matching vaultName", async () => {
    const vaultDir = workDir;
    const target = join(vaultDir, "demo", "foo.md.age");
    await writeEncrypted(target, "hello world");
    const received: string[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        defineFileArtifact({
          vaultName: "foo.md.age",
          dryRunLabel: "[dry-run] [demo] would apply foo.md",
          apply: async (decrypted) => {
            received.push(decrypted);
          },
        }),
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(received).toEqual(["hello world"]);
  });

  test("dry-run does NOT invoke apply and does NOT decrypt", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "foo.md.age"), "should-not-leak");
    let calls = 0;
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        defineFileArtifact({
          vaultName: "foo.md.age",
          dryRunLabel: "[dry-run] [demo] would apply foo.md",
          apply: async () => {
            calls += 1;
          },
        }),
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, true);
    expect(calls).toBe(0);
  });

  test("enabled() = false silently skips even when the file exists", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "gated.json.age"), "content");
    let invoked = false;
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        defineFileArtifact({
          vaultName: "gated.json.age",
          dryRunLabel: "[dry-run] [demo] would apply gated",
          apply: async () => {
            invoked = true;
          },
          enabled: () => false,
        }),
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(invoked).toBe(false);
  });

  test("missing top-level file is silently skipped (no error)", async () => {
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        defineFileArtifact({
          vaultName: "absent.md.age",
          dryRunLabel: "[dry-run] [demo] would apply absent",
          apply: async () => {
            throw new Error("must not run");
          },
        }),
      ],
    };
    await runApplyPlan(plan, workDir, identity, false);
  });
});

describe("runApplyPlan DirArtifact", () => {
  test("decrypts every matching entry and strips the suffix", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "commands", "foo.md.age"), "FOO");
    await writeEncrypted(join(vaultDir, "demo", "commands", "bar.md.age"), "BAR");
    const seen: { name: string; body: string }[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "dir",
          subdir: "commands",
          suffix: ".age",
          dryRunVerb: "would write command:",
          apply: async (name, body) => {
            seen.push({ name, body });
          },
        },
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(seen.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "bar.md", body: "BAR" },
      { name: "foo.md", body: "FOO" },
    ]);
  });

  test("passes nested relative names only to recursive directives", async () => {
    await writeEncrypted(join(workDir, "demo", "commands", "team", "review.md.age"), "REVIEW");
    const seen: string[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "dir",
          subdir: "commands",
          suffix: ".age",
          recursive: true,
          dryRunVerb: "would write command:",
          apply: async (name) => {
            seen.push(name);
          },
        },
      ],
    };
    await runApplyPlan(plan, workDir, identity, false);
    expect(seen).toEqual(["team/review.md"]);
  });

  test("preflights the complete recursive artifact set before apply", async () => {
    await writeEncrypted(join(workDir, "demo", "commands", "a.md.age"), "A");
    await writeEncrypted(join(workDir, "demo", "commands", "nested", "b.md.age"), "B");
    const events: string[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      preflight: async (paths) => {
        events.push(`preflight:${paths.join(",")}`);
      },
      directives: [
        {
          kind: "dir",
          subdir: "commands",
          suffix: ".age",
          recursive: true,
          dryRunVerb: "would write command:",
          apply: async (name) => {
            events.push(`apply:${name}`);
          },
        },
      ],
    };
    await runApplyPlan(plan, workDir, identity, false);
    expect(events).toEqual([
      "preflight:demo/commands/a.md.age,demo/commands/nested/b.md.age",
      "apply:a.md",
      "apply:nested/b.md",
    ]);
  });

  test("`match` filter rejects non-matching files before decrypt", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "instr", "x.instructions.md.age"), "OK");
    await writeEncrypted(join(vaultDir, "demo", "instr", "y.other.age"), "SKIP");
    const calls: string[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "dir",
          subdir: "instr",
          suffix: ".age",
          match: (n) => n.endsWith(".instructions.md.age"),
          dryRunVerb: "would write:",
          apply: async (name) => {
            calls.push(name);
          },
        },
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(calls).toEqual(["x.instructions.md"]);
  });

  test("`filter` skips with a reason and never invokes apply", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "skills", "valid.tar.age"), "GOOD");
    await writeEncrypted(join(vaultDir, "demo", "skills", "bad.tar.age"), "BAD");
    const applied: string[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "dir",
          subdir: "skills",
          suffix: ".tar.age",
          dryRunVerb: "would extract:",
          apply: async (name) => {
            applied.push(name);
          },
          filter: (name) => (name === "bad" ? { reason: "rejected for tests" } : null),
        },
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(applied).toEqual(["valid"]);
  });

  test("`.tar.age` suffix strips correctly", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "skills", "foo.tar.age"), "PAYLOAD");
    const seen: string[] = [];
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "dir",
          subdir: "skills",
          suffix: ".tar.age",
          dryRunVerb: "would extract:",
          apply: async (name) => {
            seen.push(name);
          },
        },
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(seen).toEqual(["foo"]);
  });
});

describe("runApplyPlan EscapeHatch", () => {
  test("custom directive receives the resolved agent vault dir", async () => {
    const vaultDir = workDir;
    mkdirSync(join(vaultDir, "demo", "plugins"), { recursive: true });
    let captured = "";
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "custom",
          run: async (agentVaultDir) => {
            captured = agentVaultDir;
          },
        },
      ],
    };
    await runApplyPlan(plan, vaultDir, identity, false);
    expect(captured).toBe(join(vaultDir, "demo"));
  });

  test("custom directive receives dryRun=true when applicable", async () => {
    const observed: { value: boolean | null } = { value: null };
    const plan: ApplyPlan = {
      agent: "demo",
      directives: [
        {
          kind: "custom",
          run: async (_dir, _key, dryRun) => {
            observed.value = dryRun;
          },
        },
      ],
    };
    await runApplyPlan(plan, workDir, identity, true);
    expect(observed.value).toBe(true);
  });
});

describe("runApplyPlan warnOnUnknownTopLevel", () => {
  test("does not throw when an unknown top-level file is present", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "known.age"), "ok");
    await writeEncrypted(join(vaultDir, "demo", "unknown.age"), "ok");
    const plan: ApplyPlan = {
      agent: "demo",
      warnOnUnknownTopLevel: true,
      directives: [
        defineFileArtifact({
          vaultName: "known.age",
          dryRunLabel: "[dry-run] [demo] would apply known",
          apply: async () => {
            // no-op
          },
        }),
      ],
    };
    // Side effect is a log.warn — we just assert the call doesn't throw and
    // the recognised directive still ran (proved below by absence of
    // exception when the unknown file co-exists).
    await runApplyPlan(plan, vaultDir, identity, false);
    // sanity: vault still contains both files (we didn't accidentally write or remove)
    const remaining = readdirSync(join(vaultDir, "demo"));
    expect(remaining.sort()).toEqual(["known.age", "unknown.age"]);
  });
});

describe("skillNameFilter", () => {
  const filter = skillNameFilter();

  test("returns null for a valid skill name", () => {
    expect(filter("my-skill")).toBeNull();
  });

  test("maps an invalid skill name to a skip reason", () => {
    const result = filter("..");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("invalid skill name");
  });
});

describe("dirWriteApplier", () => {
  test("writes the file and creates parent directories", async () => {
    const dir = join(workDir, "a", "b");
    await dirWriteApplier({ dir })("note.md", "hello");
    expect(readFileSync(join(dir, "note.md"), "utf8")).toBe("hello");
  });

  test("backs up an existing target only when backup is true", async () => {
    const dir = join(workDir, "cmds");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "c.md"), "old");
    await dirWriteApplier({ dir, backup: true })("c.md", "new");
    expect(readFileSync(join(dir, "c.md"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "c.md.bak"), "utf8")).toBe("old");

    const noBackupDir = join(workDir, "nobak");
    mkdirSync(noBackupDir, { recursive: true });
    writeFileSync(join(noBackupDir, "d.md"), "old");
    await dirWriteApplier({ dir: noBackupDir })("d.md", "new");
    expect(existsSync(join(noBackupDir, "d.md.bak"))).toBe(false);
  });

  test("rejects names that would traverse out of the target dir, before any write", async () => {
    const dir = join(workDir, "guard");
    const applier = dirWriteApplier({ dir });
    // `\` is a separator on Windows; `/` on POSIX; `..`/`.`/empty are traversal
    // primitives; control chars are filesystem-hostile.
    for (const bad of ["..", ".", "", "a/b.md", "a\\b.md", "\u0000x.md"]) {
      await expect(applier(bad, "x")).rejects.toThrow(/Unsafe vault entry name/);
    }
    expect(existsSync(dir)).toBe(false); // guard runs before mkdir/write
  });

  test("allows a leading-dot name so dotfile .md entries still round-trip", async () => {
    const dir = join(workDir, "dotok");
    await dirWriteApplier({ dir })(".hidden.md", "x");
    expect(readFileSync(join(dir, ".hidden.md"), "utf8")).toBe("x");
  });

  test("runs validate before any write and aborts on failure", async () => {
    const dir = join(workDir, "validated");
    const applier = dirWriteApplier({
      dir,
      validate: (name) => {
        if (name.startsWith(".")) throw new Error("dotfile rejected");
      },
    });
    await expect(applier(".secret.md", "x")).rejects.toThrow("dotfile rejected");
    expect(existsSync(join(dir, ".secret.md"))).toBe(false);
  });
});

describe("makeApplyVault", () => {
  test("threads config into buildPlan and runs the plan", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "thing.age"), "payload");
    const seen: { config: unknown; applied: string[] } = { config: undefined, applied: [] };
    const buildPlan = (config?: unknown): ApplyPlan => {
      seen.config = config;
      return {
        agent: "demo",
        directives: [
          defineFileArtifact({
            vaultName: "thing.age",
            dryRunLabel: "[dry-run] [demo] would apply thing",
            apply: async (decrypted) => {
              seen.applied.push(decrypted);
            },
          }),
        ],
      };
    };
    const applyVault = makeApplyVault(buildPlan);
    const sentinel = { marker: true };
    await applyVault(vaultDir, identity, false, sentinel as never);
    expect(seen.config).toBe(sentinel);
    expect(seen.applied).toEqual(["payload"]);
  });

  test("threads the dryRun flag through to the plan", async () => {
    const vaultDir = workDir;
    await writeEncrypted(join(vaultDir, "demo", "thing.age"), "payload");
    const applied: string[] = [];
    const buildPlan = (): ApplyPlan => ({
      agent: "demo",
      directives: [
        defineFileArtifact({
          vaultName: "thing.age",
          dryRunLabel: "[dry-run] [demo] would apply thing",
          apply: async (decrypted) => {
            applied.push(decrypted);
          },
        }),
      ],
    });
    await makeApplyVault(buildPlan)(vaultDir, identity, true, undefined);
    // dryRun=true must reach runApplyPlan, which skips the apply callback.
    expect(applied).toEqual([]);
  });
});
