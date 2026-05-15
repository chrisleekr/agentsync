import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encryptString, generateIdentity, identityToRecipient } from "../../core/encryptor";
import { type ApplyPlan, defineFileArtifact, readAgeFiles, runApplyPlan } from "../_apply";

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
