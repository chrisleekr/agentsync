import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { AgentPaths } from "../../config/paths";
import { applyMigrated, performMigrate, performMigrateTargets } from "../migrate";

const paths = AgentPaths as unknown as Record<string, Record<string, string>>;
const OPEN_CODE_ENV_KEYS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
] as const;
let root: string;
let original: Record<string, Record<string, string>>;
let originalOpenCodeEnvironment: Record<string, string | undefined>;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function claude(name: string): string {
  return `---\nname: ${name}\ndescription: Reviews\n---\n\nReview.`;
}

function shared(target?: "github-copilot" | "vscode"): string {
  const targetField = target ? `target: ${target}\n` : "";
  return `---\ndescription: Reviews\n${targetField}---\n\nReview.`;
}

beforeEach(() => {
  root = join(
    realpathSync(tmpdir()),
    `agents-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  original = structuredClone(paths);
  originalOpenCodeEnvironment = Object.fromEntries(
    OPEN_CODE_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of OPEN_CODE_ENV_KEYS) delete process.env[key];
  paths.claude.agentsDir = join(root, "claude");
  paths.cursor.agentsDir = join(root, "cursor");
  paths.codex.agentsDir = join(root, "codex");
  paths.copilot.agentsDir = join(root, "shared");
  paths.vscode.agentsDir = paths.copilot.agentsDir;
  const openCodeDefaultDir = join(root, "opencode-default");
  const openCodeOverrideDir = join(root, "opencode-override");
  paths.opencode.configDir = openCodeDefaultDir;
  process.env.OPENCODE_CONFIG_DIR = openCodeOverrideDir;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [agent, values] of Object.entries(original)) Object.assign(paths[agent], values);
  for (const key of OPEN_CODE_ENV_KEYS) {
    const value = originalOpenCodeEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent source and static target safety", () => {
  test("a non-directory source root is an error and writes nothing", async () => {
    write(paths.claude.agentsDir, "not a directory");
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("source directory");
    expect(result.migrated).toEqual([]);
  });

  test("a symlinked source root is an error and writes nothing", async () => {
    const outside = join(root, "outside-source");
    write(join(outside, "reviewer.md"), claude("reviewer"));
    symlinkSync(outside, paths.claude.agentsDir);
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("source directory");
    expect(result.migrated).toEqual([]);
  });

  test("an empty source file aborts the physical target batch", async () => {
    write(join(paths.claude.agentsDir, "empty.md"), "");
    write(join(paths.claude.agentsDir, "valid.md"), claude("valid"));
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("Invalid YAML frontmatter");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(join(paths.cursor.agentsDir, "valid.md")).exists()).toBe(false);
  });

  test.each([true, false])("rejects a symlinked target root in dry-run=%s", async (dryRun) => {
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, paths.cursor.agentsDir);
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun,
    });
    expect(result.errors.join("\n")).toContain("real directory");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(join(outside, "reviewer.md")).exists()).toBe(false);
  });

  test.each([
    ["claude", "reviewer.md"],
    ["cursor", "reviewer.md"],
    ["codex", "reviewer.toml"],
    ["copilot", "reviewer.agent.md"],
    ["vscode", "reviewer.agent.md"],
  ] as const)("rejects a symlinked ancestor above the %s agent root", async (target, targetName) => {
    const outside = join(root, `outside-${target}`);
    const linkedParent = join(root, `linked-${target}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, linkedParent);
    paths[target].agentsDir = join(linkedParent, "agents");

    for (const dryRun of [true, false]) {
      await expect(
        applyMigrated(target, "agents", targetName, claude("reviewer"), dryRun),
      ).rejects.toThrow(/directory component/);
      expect(await Bun.file(join(outside, "agents", targetName)).exists()).toBe(false);
    }
  });

  test("rejects symlink and directory destinations without changing another batch file", async () => {
    write(join(paths.claude.agentsDir, "blocked.md"), claude("blocked"));
    write(join(paths.claude.agentsDir, "valid.md"), claude("valid"));
    mkdirSync(paths.cursor.agentsDir, { recursive: true });
    const outside = join(root, "outside.md");
    write(outside, "outside");
    symlinkSync(outside, join(paths.cursor.agentsDir, "blocked.md"));
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("regular file");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(outside).text()).toBe("outside");
    expect(await Bun.file(join(paths.cursor.agentsDir, "valid.md")).exists()).toBe(false);

    await rm(join(paths.cursor.agentsDir, "blocked.md"));
    mkdirSync(join(paths.cursor.agentsDir, "blocked.md"));
    const directoryResult = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: true,
    });
    expect(directoryResult.errors.join("\n")).toContain("regular file");
    expect(directoryResult.migrated).toEqual([]);
  });

  test("rejects portable path hazards in the common apply boundary", async () => {
    for (const name of ["CON.md", "COM¹.md", "bad:name.md", "trailing.md.", "trailing.md "]) {
      await expect(applyMigrated("cursor", "agents", name, claude("safe"), true)).rejects.toThrow(
        /Windows-reserved/,
      );
    }
  });

  test("preserves an existing agent file mode on overwrite", async () => {
    if (process.platform === "win32") return;
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    const destination = join(paths.cursor.agentsDir, "reviewer.md");
    write(destination, "existing");
    await chmod(destination, 0o600);

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  test("creates a new agent file with mode 0600", async () => {
    if (process.platform === "win32") return;
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    const destination = join(paths.cursor.agentsDir, "reviewer.md");

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  test("deduplicates shared targets without dropping other selected targets", async () => {
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));

    const result = await performMigrateTargets({
      from: "claude",
      targets: ["cursor", "copilot", "vscode"],
      types: ["agents"],
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated.map(({ targetPath }) => targetPath)).toEqual([
      join(paths.cursor.agentsDir, "reviewer.md"),
      join(paths.copilot.agentsDir, "reviewer.agent.md"),
    ]);
    expect(result.migrated[1]?.content).not.toContain("target:");
  });
});

describe("existing target ownership and collision preflight", () => {
  test("shared overwrite requires exactly matching logical coverage", async () => {
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    const destination = join(paths.copilot.agentsDir, "reviewer.agent.md");
    write(destination, shared("vscode"));
    const result = await performMigrate({
      from: "claude",
      to: "copilot",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("does not match incoming");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(destination).text()).toBe(shared("vscode"));

    write(destination, shared("github-copilot"));
    const applied = await performMigrate({
      from: "claude",
      to: "copilot",
      type: "agents",
      dryRun: false,
    });
    expect(applied.errors).toEqual([]);
    expect(applied.migrated).toHaveLength(1);
  });

  test.each([
    ["malformed", "not frontmatter"],
    ["invalid target", "---\ndescription: Reviews\ntarget: other\n---\n\nReview."],
    ["broaden", shared()],
  ])("rejects existing shared ownership: %s", async (_label, existing) => {
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    write(join(paths.copilot.agentsDir, "reviewer.agent.md"), existing);
    const result = await performMigrate({
      from: "claude",
      to: "copilot",
      type: "agents",
      dryRun: true,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.migrated).toEqual([]);
  });

  test.each([
    ["case", "Reviewer.md"],
    ["Unicode normalization", "re\u0301viewer.toml"],
  ])("rejects existing %s collision before writing another source", async (_label, existingName) => {
    const unicode = existingName.endsWith(".toml");
    if (unicode) {
      write(join(paths.copilot.agentsDir, "réviewer.agent.md"), shared("github-copilot"));
      write(join(paths.copilot.agentsDir, "valid.agent.md"), shared("github-copilot"));
      write(join(paths.codex.agentsDir, existingName), "existing");
    } else {
      write(join(paths.claude.agentsDir, "one.md"), claude("reviewer"));
      write(join(paths.claude.agentsDir, "valid.md"), claude("valid"));
      write(join(paths.cursor.agentsDir, existingName), "existing");
    }
    const result = await performMigrate({
      from: unicode ? "copilot" : "claude",
      to: unicode ? "codex" : "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("collision");
    expect(result.migrated).toEqual([]);
    const validTarget = unicode
      ? join(paths.codex.agentsDir, "valid.toml")
      : join(paths.cursor.agentsDir, "valid.md");
    expect(await Bun.file(validTarget).exists()).toBe(false);
  });

  test("rejects changed shared coverage while other to-all targets proceed", async () => {
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    const destination = join(paths.copilot.agentsDir, "reviewer.agent.md");
    write(destination, shared("github-copilot"));
    const result = await performMigrate({
      from: "claude",
      to: "all",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("does not match incoming");
    expect(result.migrated.map(({ targetPath }) => targetPath)).toEqual([
      join(paths.cursor.agentsDir, "reviewer.md"),
      join(paths.codex.agentsDir, "reviewer.toml"),
      join(root, "opencode-override", "agents", "reviewer.md"),
    ]);
    expect(result.migrated.every(({ targetPath }) => targetPath.startsWith(`${root}${sep}`))).toBe(
      true,
    );
    expect(await Bun.file(destination).text()).toBe(shared("github-copilot"));
  });

  test("rejects two pre-existing case-equivalent filenames even when one is exact", async () => {
    write(join(paths.claude.agentsDir, "reviewer.md"), claude("reviewer"));
    write(join(paths.cursor.agentsDir, "reviewer.md"), "exact");
    write(join(paths.cursor.agentsDir, "Reviewer.MD"), "equivalent");
    if ((await readdir(paths.cursor.agentsDir)).length < 2) return;
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(result.errors.join("\n")).toContain("collision");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(join(paths.cursor.agentsDir, "reviewer.md")).text()).toBe("exact");
  });
});
