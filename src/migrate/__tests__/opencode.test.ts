import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { Agents } from "../../agents/registry";
import { AgentPaths } from "../../config/paths";
import { AgentSyncConfigSchema, MigrateOptionsSchema } from "../../config/schema";
import { OPEN_CODE_SKILL_FLAGS } from "../../opencode/runtime-flags";
import {
  applyMigrated,
  performMigrate,
  performMigrateTargets,
  readSourceArtefacts,
} from "../migrate";
import { getSupportedPairs } from "../registry";
import { translateMcp } from "../translators/mcp";

const VALID_RECIPIENT = "age1qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const mutablePaths = AgentPaths as unknown as {
  claude: {
    claudeMd: string;
    mcpJson: string;
    commandsDir: string;
    agentsDir: string;
    skillsDir: string;
    rulesDir: string;
  };
  cursor: { skillsDir: string; commandsDir: string; mcpGlobal: string; settingsJson: string };
  codex: { skillsDir: string; userSkillsDir: string; configToml: string; agentsMd: string };
  copilot: {
    skillsDir: string;
    promptsDir: string;
    mcpConfigJson: string;
    instructionsFile: string;
  };
  vscode: { mcpJson: string };
  opencode: { configDir: string; homeConfigDir: string };
};

let root: string;
let originalOpenCode: typeof AgentPaths.opencode;
let originalClaude: typeof mutablePaths.claude;
let originalCursor: typeof mutablePaths.cursor;
let originalCodexSkills: typeof mutablePaths.codex;
let originalCopilot: typeof mutablePaths.copilot;
let originalVscodeMcp: string;
let originalEnvironment: Record<string, string | undefined>;
const OPEN_CODE_ENVIRONMENT_KEYS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  ...OPEN_CODE_SKILL_FLAGS,
];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function expectWritableFixtureTargetsContained(): void {
  const writableTargets = [
    ...Object.values(mutablePaths.opencode),
    mutablePaths.claude.claudeMd,
    mutablePaths.claude.mcpJson,
    mutablePaths.claude.commandsDir,
    mutablePaths.claude.agentsDir,
    mutablePaths.claude.skillsDir,
    mutablePaths.claude.rulesDir,
    mutablePaths.cursor.skillsDir,
    mutablePaths.cursor.commandsDir,
    mutablePaths.cursor.mcpGlobal,
    mutablePaths.cursor.settingsJson,
    mutablePaths.codex.skillsDir,
    mutablePaths.codex.userSkillsDir,
    mutablePaths.codex.configToml,
    mutablePaths.codex.agentsMd,
    mutablePaths.copilot.skillsDir,
    mutablePaths.copilot.promptsDir,
    mutablePaths.copilot.mcpConfigJson,
    mutablePaths.copilot.instructionsFile,
    mutablePaths.vscode.mcpJson,
  ];
  expect(writableTargets.every((target) => target.startsWith(`${root}${sep}`))).toBe(true);
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agentsync-opencode-"));
  originalOpenCode = { ...AgentPaths.opencode };
  originalClaude = { ...mutablePaths.claude };
  originalCursor = { ...mutablePaths.cursor };
  originalCodexSkills = { ...mutablePaths.codex };
  originalCopilot = { ...mutablePaths.copilot };
  originalVscodeMcp = AgentPaths.vscode.mcpJson;
  originalEnvironment = Object.fromEntries(
    OPEN_CODE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  const configDir = join(root, "default", "opencode");
  mutablePaths.opencode.configDir = configDir;
  mutablePaths.opencode.homeConfigDir = join(root, ".opencode");
  Object.assign(mutablePaths.claude, {
    claudeMd: join(root, ".claude", "CLAUDE.md"),
    mcpJson: join(root, "claude", ".claude.json"),
    commandsDir: join(root, ".claude", "commands"),
    agentsDir: join(root, ".claude", "agents"),
    skillsDir: join(root, ".claude", "skills"),
    rulesDir: join(root, ".claude", "rules"),
  });
  Object.assign(mutablePaths.cursor, {
    skillsDir: join(root, ".cursor", "skills"),
    commandsDir: join(root, ".cursor", "commands"),
    mcpGlobal: join(root, ".cursor", "mcp.json"),
    settingsJson: join(root, ".cursor", "settings.json"),
  });
  Object.assign(mutablePaths.codex, {
    skillsDir: join(root, ".codex", "skills"),
    userSkillsDir: join(root, ".agents", "skills"),
    configToml: join(root, ".codex", "config.toml"),
    agentsMd: join(root, ".codex", "AGENTS.md"),
  });
  Object.assign(mutablePaths.copilot, {
    skillsDir: join(root, ".copilot", "skills"),
    promptsDir: join(root, ".copilot", "prompts"),
    mcpConfigJson: join(root, ".copilot", "mcp-config.json"),
    instructionsFile: join(root, ".copilot", "copilot-instructions.md"),
  });
  mutablePaths.vscode.mcpJson = join(root, ".vscode", "mcp.json");
  for (const key of OPEN_CODE_ENVIRONMENT_KEYS) delete process.env[key];
  expectWritableFixtureTargetsContained();
});

afterEach(async () => {
  Object.assign(mutablePaths.opencode, originalOpenCode);
  Object.assign(mutablePaths.claude, originalClaude);
  Object.assign(mutablePaths.cursor, originalCursor);
  Object.assign(mutablePaths.codex, originalCodexSkills);
  Object.assign(mutablePaths.copilot, originalCopilot);
  mutablePaths.vscode.mcpJson = originalVscodeMcp;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("OpenCode migration boundary", () => {
  test("keeps OpenCode migration and vault identities aligned", () => {
    expect(Agents.map(({ name }) => name)).toEqual([
      "claude",
      "cursor",
      "codex",
      "copilot",
      "vscode",
      "opencode",
    ]);

    const vaultConfig = AgentSyncConfigSchema.safeParse({
      version: 2,
      recipients: { local: VALID_RECIPIENT },
      agents: {
        claude: true,
        cursor: true,
        codex: true,
        copilot: true,
        vscode: false,
        opencode: true,
      },
      remote: { url: "git@github.com:user/vault.git", branch: "main" },
    });
    expect(vaultConfig.success).toBe(true);
    if (vaultConfig.success) {
      expect(vaultConfig.data.agents.opencode).toBe(true);
    }

    expect(
      MigrateOptionsSchema.safeParse({
        from: "opencode",
        to: "claude",
        type: "global-rules",
        dryRun: true,
      }).success,
    ).toBe(true);
    expect(
      MigrateOptionsSchema.safeParse({
        from: "claude",
        to: "opencode",
        type: "global-rules",
        dryRun: true,
      }).success,
    ).toBe(true);
  });

  test("registers OpenCode migration pairs for supported categories only", () => {
    const opencodePairs = getSupportedPairs().filter(
      ({ from, to }) => (from as string) === "opencode" || (to as string) === "opencode",
    );
    const types = new Set(opencodePairs.map(({ type }) => type));

    expect(types).toEqual(new Set(["global-rules", "mcp", "commands", "skills", "agents"]));
    expect(types.has("rules")).toBe(false);
    expect(
      opencodePairs.some(
        ({ from, to, type }) =>
          (from as string) === "opencode" && to === "claude" && type === "global-rules",
      ),
    ).toBe(true);
    expect(
      opencodePairs.some(
        ({ from, to, type }) =>
          from === "claude" && (to as string) === "opencode" && type === "global-rules",
      ),
    ).toBe(true);
  });

  test("exposes OpenCode through the multi-target orchestration seam", async () => {
    write(AgentPaths.claude.claudeMd, "Use the source rules.\n");
    write(join(AgentPaths.claude.commandsDir, "review.md"), "Review.\n");

    const result = await performMigrateTargets({
      from: "claude",
      targets: ["opencode", "opencode"],
      types: ["global-rules", "commands", "commands"],
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated.map(({ targetPath }) => targetPath).sort()).toEqual(
      [
        join(AgentPaths.opencode.configDir, "AGENTS.md"),
        join(AgentPaths.opencode.configDir, "commands", "review.md"),
      ].sort(),
    );
    expect(result.migrated.every(({ targetPath }) => targetPath.startsWith(`${root}${sep}`))).toBe(
      true,
    );
  });

  test("merges default and additive OpenCode config sources in precedence order", async () => {
    const configDir = AgentPaths.opencode.configDir;
    const overrideDir = join(root, "override");
    process.env.OPENCODE_CONFIG_DIR = overrideDir;
    write(
      join(configDir, "config.json"),
      JSON.stringify({
        mcp: {
          base: { type: "local", command: ["base"] },
          layered: { type: "local", command: ["config"], enabled: true },
        },
      }),
    );
    write(
      join(configDir, "opencode.json"),
      JSON.stringify({ mcp: { middle: { type: "local", command: ["middle"] } } }),
    );
    write(
      join(configDir, "opencode.jsonc"),
      '{\n  // default JSONC wins over default JSON\n  "mcp": { "layered": { "type": "local", "command": ["default-jsonc"] } },\n}\n',
    );
    write(
      join(overrideDir, "opencode.json"),
      JSON.stringify({ mcp: { override: { type: "local", command: ["override-json"] } } }),
    );
    write(
      join(overrideDir, "opencode.jsonc"),
      '{ "mcp": { "layered": { "type": "local", "command": ["override-jsonc"] } } }',
    );

    const [artifact] = await readSourceArtefacts("opencode", "mcp");
    const parsed = JSON.parse(artifact?.content ?? "{}") as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(parsed.mcp).sort()).toEqual(["base", "layered", "middle", "override"]);
    expect(parsed.mcp.layered.command).toEqual(["override-jsonc"]);
    expect(parsed.mcp.layered.enabled).toBe(true);
    expect(artifact?.sourcePath).toBe(join(overrideDir, "opencode.jsonc"));
  });

  test("rejects an invalid MCP entry in an individual OpenCode config layer", async () => {
    const configDir = AgentPaths.opencode.configDir;
    write(
      join(configDir, "opencode.json"),
      JSON.stringify({
        mcp: { layered: { type: "local", command: ["base"], enabled: true } },
      }),
    );
    write(
      join(configDir, "opencode.jsonc"),
      '{ "mcp": { "layered": { "command": ["invalid-fragment"] } } }',
    );

    await expect(readSourceArtefacts("opencode", "mcp")).rejects.toThrow(
      "invalid MCP configuration",
    );
  });

  test("discovers global rules and recursive singular and plural OpenCode artifacts", async () => {
    const configDir = AgentPaths.opencode.configDir;
    const overrideDir = join(root, "override");
    process.env.OPENCODE_CONFIG_DIR = overrideDir;
    write(join(configDir, "AGENTS.md"), "default rules");
    write(join(overrideDir, "AGENTS.md"), "override rules");
    write(join(configDir, "command", "teams", "review.md"), "Review code.");
    write(join(configDir, "commands", "lint.md"), "Lint code.");
    write(join(overrideDir, "commands", "release", "ship.md"), "Ship code.");
    const agent = (description: string) =>
      `---\ndescription: ${description}\nmode: subagent\n---\n\nAct safely.\n`;
    write(join(configDir, "agent", "teams", "reviewer.md"), agent("Reviews code"));
    write(join(overrideDir, "agents", "release.md"), agent("Releases code"));
    write(
      join(configDir, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n\nReview.\n",
    );
    write(
      join(overrideDir, "skill", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release code\n---\n\nRelease.\n",
    );

    expect((await readSourceArtefacts("opencode", "global-rules"))[0]?.content).toBe(
      "override rules",
    );
    expect(
      (await readSourceArtefacts("opencode", "commands")).map(({ name }) => name).sort(),
    ).toEqual(["lint.md", "release/ship.md", "teams/review.md"]);
    expect(
      (await readSourceArtefacts("opencode", "agents")).map(({ name }) => name).sort(),
    ).toEqual(["release.md", "teams/reviewer.md"]);
    expect(
      (await readSourceArtefacts("opencode", "skills")).map(({ name }) => name).sort(),
    ).toEqual(["release", "review"]);
  });

  test("OpenCode global rules and config sources reject non-regular files and symlinks", async () => {
    const rulesPath = join(AgentPaths.opencode.configDir, "AGENTS.md");
    mkdirSync(rulesPath, { recursive: true });
    const rules = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "global-rules",
      dryRun: false,
    });
    expect(rules.migrated).toEqual([]);
    expect(rules.errors.join("\n")).toContain("must be a regular file");
    expect(existsSync(AgentPaths.claude.claudeMd)).toBe(false);

    await rm(rulesPath, { recursive: true, force: true });
    const externalConfig = join(root, "external-opencode.json");
    write(externalConfig, JSON.stringify({ mcp: { local: { type: "local", command: ["node"] } } }));
    symlinkSync(externalConfig, join(AgentPaths.opencode.configDir, "opencode.json"));
    const mcp = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "mcp",
      dryRun: false,
    });
    expect(mcp.migrated).toEqual([]);
    expect(mcp.errors.join("\n")).toContain("must be a regular file");
    expect(existsSync(AgentPaths.claude.mcpJson)).toBe(false);
  });

  test("an unreadable OpenCode skill sidecar aborts the package", async () => {
    if (
      process.platform === "win32" ||
      (typeof process.geteuid === "function" && process.geteuid() === 0)
    ) {
      return;
    }
    const skillDir = join(AgentPaths.opencode.configDir, "skills", "review");
    const sidecar = join(skillDir, "reference.md");
    write(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review\n---\n\nReview.\n");
    write(sidecar, "Private reference.\n");
    chmodSync(sidecar, 0o000);
    try {
      const result = await performMigrate({
        from: "opencode",
        to: "claude",
        type: "skills",
        dryRun: false,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("reference.md");
      expect(existsSync(join(AgentPaths.claude.skillsDir, "review", "SKILL.md"))).toBe(false);
    } finally {
      chmodSync(sidecar, 0o600);
    }
  });

  test("keeps nested OpenCode skills out of their parent package sidecars", async () => {
    const skillsRoot = join(AgentPaths.opencode.configDir, "skills");
    write(
      join(skillsRoot, "parent", "SKILL.md"),
      "---\nname: parent\ndescription: Parent\n---\n\nParent.\n",
    );
    write(join(skillsRoot, "parent", "reference.md"), "Parent reference.\n");
    write(
      join(skillsRoot, "parent", "child", "SKILL.md"),
      "---\nname: child\ndescription: Child\n---\n\nChild.\n",
    );
    write(join(skillsRoot, "parent", "child", "child.md"), "Child reference.\n");

    const sources = await readSourceArtefacts("opencode", "skills");
    expect(sources.map(({ name }) => name).sort()).toEqual(["child", "parent"]);
    expect(
      sources.find(({ name }) => name === "parent")?.sidecars?.map(({ relPath }) => relPath),
    ).toEqual(["reference.md"]);
    expect(
      sources.find(({ name }) => name === "child")?.sidecars?.map(({ relPath }) => relPath),
    ).toEqual(["child.md"]);

    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "skills",
      name: "parent",
      dryRun: false,
    });
    expect(result.errors).toEqual([]);
    expect(existsSync(join(AgentPaths.claude.skillsDir, "parent", "reference.md"))).toBe(true);
    expect(existsSync(join(AgentPaths.claude.skillsDir, "parent", "child", "SKILL.md"))).toBe(
      false,
    );
    expect(existsSync(join(AgentPaths.claude.skillsDir, "child", "SKILL.md"))).toBe(false);
  });

  test("preserves a nested OpenCode agent identity and fails closed for a flat target", async () => {
    const sourcePath = join(AgentPaths.opencode.configDir, "agents", "teams", "reviewer.md");
    write(sourcePath, "---\ndescription: Reviews code\nmode: subagent\n---\n\nReview carefully.\n");

    const sources = await readSourceArtefacts("opencode", "agents");
    expect(sources.map(({ name }) => name)).toEqual(["teams/reviewer.md"]);

    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "agents",
      dryRun: false,
    });
    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("agents, teams/reviewer.md");
    expect(result.errors.join("\n")).toContain("claude target identity is not path-safe");
    await expect(Bun.file(join(AgentPaths.claude.agentsDir, "reviewer.md")).exists()).resolves.toBe(
      false,
    );
  });

  test("treats root and nested OpenCode agent paths as distinct target identities", async () => {
    const openCodeAgent =
      "---\ndescription: Existing reviewer\nmode: subagent\n---\n\nReview carefully.\n";
    write(join(AgentPaths.opencode.configDir, "agents", "reviewer.md"), openCodeAgent);
    write(join(AgentPaths.opencode.configDir, "agents", "teams", "reviewer.md"), openCodeAgent);
    write(
      join(AgentPaths.claude.agentsDir, "planner.md"),
      "---\nname: planner\ndescription: Plans changes\n---\n\nPlan carefully.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "agents",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated.map(({ targetPath }) => targetPath)).toEqual([
      join(AgentPaths.opencode.configDir, "agents", "planner.md"),
    ]);
  });

  test("shared Claude skills are not copied while OpenCode discovers them", async () => {
    write(
      join(AgentPaths.claude.skillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.warnings.join("\n")).toContain("already discovers this shared skill root");
  });

  test("shared skill discovery still rejects authority OpenCode would ignore", async () => {
    write(
      join(AgentPaths.claude.skillsDir, "restricted", "SKILL.md"),
      "---\nname: restricted\ndescription: Restricted\ndisallowed-tools: [Write]\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("authority field 'disallowed-tools'");
    expect(result.warnings.join("\n")).not.toContain("already discovers this shared skill root");
  });

  test("shared skill discovery rejects Claude shell interpolation OpenCode would ignore", async () => {
    write(
      join(AgentPaths.claude.skillsDir, "dynamic", "SKILL.md"),
      "---\nname: dynamic\ndescription: Dynamic\n---\n\nReview !`git diff`.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("does not execute");
    expect(result.warnings.join("\n")).not.toContain("already discovers this shared skill root");
  });

  test("Claude file imports preserve an existing OpenCode rules target", async () => {
    const target = join(AgentPaths.opencode.configDir, "AGENTS.md");
    const targetRaw = "Existing OpenCode rules.\n";
    write(target, targetRaw);
    write(AgentPaths.claude.claudeMd, "Read @policy.md before answering.\n");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "claude",
        to: "opencode",
        type: "global-rules",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("file import");
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test.each([
    "true",
    "yes",
    "on",
    "1",
    "y",
  ])("external-skill disable value %s copies Claude skills into OpenCode", async (value) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = value;
    write(
      join(AgentPaths.claude.skillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated.map(({ targetPath }) => targetPath)).toEqual([
      join(AgentPaths.opencode.configDir, "skills", "review", "SKILL.md"),
    ]);
  });

  test.each([
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  ] as const)("%s copies Claude skills into OpenCode native storage", async (flag) => {
    process.env[flag] = "true";
    write(
      join(AgentPaths.claude.skillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
  });

  test.each([
    "false",
    "no",
    "off",
    "0",
    "n",
  ])("explicit false value %s keeps shared Claude skills visible without copying", async (value) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = value;
    process.env.OPENCODE_DISABLE_CLAUDE_CODE = value;
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = value;
    write(
      join(AgentPaths.claude.skillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.warnings.join("\n")).toContain("already discovers this shared skill root");
  });

  test("external-skill discovery controls copying from the shared Codex root", async () => {
    write(
      join(AgentPaths.codex.userSkillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    let result = await performMigrate({
      from: "codex",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated).toEqual([]);

    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    result = await performMigrate({
      from: "codex",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
  });

  test("legacy Codex skills copy because OpenCode does not discover that root", async () => {
    write(
      join(AgentPaths.codex.skillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "codex",
      to: "opencode",
      type: "skills",
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
  });

  test("invalid OpenCode Boolean flags abort before native skill writes", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "TRUE";
    write(
      join(AgentPaths.claude.skillsDir, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("OPENCODE_DISABLE_EXTERNAL_SKILLS");
    expect(result.errors.join("\n")).toContain("case-sensitive");
    expect(existsSync(join(AgentPaths.opencode.configDir, "skills"))).toBe(false);
  });

  test("OpenCode writes global rules, commands, agents, and skills only under the temp root", async () => {
    write(AgentPaths.claude.claudeMd, "Use the migrated rules.\n");
    write(join(AgentPaths.claude.commandsDir, "review.md"), "Review the change.\n");
    write(
      join(AgentPaths.claude.agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\n\nReview carefully.\n",
    );

    const core = await performMigrate({ from: "claude", to: "opencode", dryRun: false });
    expect(core.errors).toEqual([]);
    expect(core.migrated.map(({ targetPath }) => targetPath).sort()).toEqual(
      [
        join(AgentPaths.opencode.configDir, "AGENTS.md"),
        join(AgentPaths.opencode.configDir, "agents", "reviewer.md"),
        join(AgentPaths.opencode.configDir, "commands", "review.md"),
      ].sort(),
    );
    expect(core.migrated.every(({ targetPath }) => targetPath.startsWith(`${root}${sep}`))).toBe(
      true,
    );
    expect(
      readFileSync(join(AgentPaths.opencode.configDir, "agents", "reviewer.md"), "utf8"),
    ).toContain("mode: subagent");

    write(
      join(AgentPaths.cursor.skillsDir, "release", "SKILL.md"),
      "---\nname: release\ndescription: Release safely\n---\n\nRelease.\n",
    );
    write(join(AgentPaths.cursor.skillsDir, "release", "reference.md"), "Reference.\n");
    const skill = await performMigrate({
      from: "cursor",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });
    expect(skill.errors).toEqual([]);
    expect(skill.migrated).toHaveLength(1);
    expect(skill.migrated[0]?.targetPath.startsWith(`${root}${sep}`)).toBe(true);
    expect(
      readFileSync(
        join(AgentPaths.opencode.configDir, "skills", "release", "reference.md"),
        "utf8",
      ),
    ).toBe("Reference.\n");
  });

  test("fails before writes on duplicate identities and unmappable agent authority", async () => {
    const configDir = AgentPaths.opencode.configDir;
    write(join(configDir, "command", "review.md"), "one");
    write(join(configDir, "commands", "review.md"), "two");
    const duplicate = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "commands",
      dryRun: false,
    });
    expect(duplicate.migrated).toEqual([]);
    expect(duplicate.errors.join("\n")).toContain("Duplicate OpenCode command identity");

    write(
      join(configDir, "agents", "restricted.md"),
      "---\ndescription: Restricted\nmode: subagent\npermission:\n  edit: deny\n---\n\nReview.\n",
    );
    const authority = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "agents",
      dryRun: false,
    });
    expect(authority.migrated).toEqual([]);
    expect(authority.errors.join("\n")).toContain("authority field 'permission'");
  });

  test("rejects command and skill authority that OpenCode would ignore", async () => {
    write(
      join(AgentPaths.claude.commandsDir, "restricted.md"),
      "---\ndisallowed-tools: [Write]\n---\n\nReview without writing.\n",
    );
    const command = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "commands",
      dryRun: false,
    });
    expect(command.migrated).toEqual([]);
    expect(command.errors.join("\n")).toContain("authority field 'disallowed-tools'");
    expect(existsSync(join(AgentPaths.opencode.configDir, "commands", "restricted.md"))).toBe(
      false,
    );

    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    write(
      join(AgentPaths.claude.skillsDir, "restricted", "SKILL.md"),
      "---\nname: restricted\ndescription: Restricted review\ndisallowed-tools: [Write]\n---\n\nReview without writing.\n",
    );
    const skill = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });
    expect(skill.migrated).toEqual([]);
    expect(skill.errors.join("\n")).toContain("authority field 'disallowed-tools'");
    expect(
      existsSync(join(AgentPaths.opencode.configDir, "skills", "restricted", "SKILL.md")),
    ).toBe(false);
  });

  test.each([
    ["shared discovery enabled", false],
    ["shared discovery disabled", true],
  ])("rejects an invalid OpenCode-target skill with %s", async (_caseName, disabled) => {
    if (disabled) process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    write(
      join(AgentPaths.claude.skillsDir, "review", "SKILL.md"),
      "---\ndescription: Review changes\n---\n\nReview.\n",
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("requires a string 'name'");
    expect(result.warnings.join("\n")).not.toContain("already discovers");
    expect(existsSync(join(AgentPaths.opencode.configDir, "skills", "review", "SKILL.md"))).toBe(
      false,
    );
  });

  test("rejects unsafe command identities and non-file OpenCode targets before writing", async () => {
    write(join(AgentPaths.claude.commandsDir, ".hidden.md"), "hidden");
    write(join(AgentPaths.claude.commandsDir, "bad:name.md"), "reserved");
    write(join(AgentPaths.claude.commandsDir, "back\\slash.md"), "separator");

    const unsafe = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "commands",
      dryRun: false,
    });
    expect(unsafe.migrated).toEqual([]);
    expect(unsafe.errors.join("\n")).toContain("hidden segment");
    expect(unsafe.errors.join("\n")).toContain("Windows-reserved character");
    expect(unsafe.errors.join("\n")).toContain("unsafe or has the wrong extension");

    await rm(AgentPaths.claude.commandsDir, { recursive: true, force: true });
    write(join(AgentPaths.claude.commandsDir, "review.md"), "Review.");
    mkdirSync(join(AgentPaths.opencode.configDir, "commands", "review.md"), {
      recursive: true,
    });
    const collision = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "commands",
      dryRun: false,
    });
    expect(collision.migrated).toEqual([]);
    expect(collision.errors.join("\n")).toContain("must be a regular file");
  });

  test.each([
    "singular root",
    "lower config directory",
  ])("rejects a normalized OpenCode command collision in the %s before any write", async (location) => {
    const overrideDir = join(root, "override-collision");
    process.env.OPENCODE_CONFIG_DIR = overrideDir;
    const existingRoot =
      location === "singular root"
        ? join(overrideDir, "command")
        : join(AgentPaths.opencode.configDir, "commands");
    write(join(existingRoot, "Review.md"), "Existing review.\n");
    write(join(AgentPaths.claude.commandsDir, "review.md"), "Incoming review.\n");
    write(join(AgentPaths.claude.commandsDir, "safe.md"), "Safe command.\n");

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "commands",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("Command target path collision");
    expect(existsSync(join(overrideDir, "commands", "safe.md"))).toBe(false);
  });

  test.each([
    "claude",
    "cursor",
    "codex",
    "copilot",
  ] as const)("rejects an existing normalized OpenCode → %s command collision before the batch writes", async (target) => {
    write(join(AgentPaths.opencode.configDir, "commands", "review.md"), "Review.\n");
    write(join(AgentPaths.opencode.configDir, "commands", "safe.md"), "Safe.\n");

    const targetRoot =
      target === "claude"
        ? AgentPaths.claude.commandsDir
        : target === "cursor"
          ? AgentPaths.cursor.commandsDir
          : target === "codex"
            ? AgentPaths.codex.userSkillsDir
            : AgentPaths.copilot.promptsDir;
    const existingPath =
      target === "codex"
        ? join(targetRoot, "Review", "SKILL.md")
        : join(targetRoot, target === "copilot" ? "Review.prompt.md" : "Review.md");
    const safePath =
      target === "codex"
        ? join(targetRoot, "safe", "SKILL.md")
        : join(targetRoot, target === "copilot" ? "safe.prompt.md" : "safe.md");
    write(existingPath, "Existing.\n");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: target,
        type: "commands",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(`Command target path collision for ${target}`);
    }
    expect(existsSync(safePath)).toBe(false);
    expect(readFileSync(existingPath, "utf8")).toBe("Existing.\n");
  });

  test("rejects an existing NFD-equivalent Claude command before the batch writes", async () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    write(join(AgentPaths.opencode.configDir, "commands", `${composed}.md`), "Review.\n");
    write(join(AgentPaths.opencode.configDir, "commands", "safe.md"), "Safe.\n");
    write(join(AgentPaths.claude.commandsDir, `${decomposed}.md`), "Existing.\n");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "claude",
        type: "commands",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("Command target path collision for claude");
    }
    expect(existsSync(join(AgentPaths.claude.commandsDir, "safe.md"))).toBe(false);
  });

  test("rejects an existing singular-root agent collision before any agent write", async () => {
    write(
      join(AgentPaths.opencode.configDir, "agent", "reviewer.md"),
      "---\ndescription: Existing reviewer\nmode: subagent\n---\n\nExisting.\n",
    );
    for (const name of ["reviewer", "safe"]) {
      write(
        join(AgentPaths.claude.agentsDir, `${name}.md`),
        `---\nname: ${name}\ndescription: Incoming ${name}\n---\n\nReview.\n`,
      );
    }

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "agents",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("Agent target path collision");
    expect(existsSync(join(AgentPaths.opencode.configDir, "agents", "safe.md"))).toBe(false);
  });

  test("rejects an intermediate symlink in a nested non-OpenCode command target", async () => {
    write(
      join(AgentPaths.opencode.configDir, "commands", "teams", "review.md"),
      "Review the team change.\n",
    );
    const external = join(root, "external-command-target");
    mkdirSync(AgentPaths.claude.commandsDir, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(AgentPaths.claude.commandsDir, "teams"), "dir");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "claude",
        type: "commands",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("must be a real directory");
    }
    expect(existsSync(join(external, "review.md"))).toBe(false);
  });

  test("rejects OpenCode command shell interpolation introduced from plain Markdown", async () => {
    const cursorCommands = AgentPaths.cursor as unknown as { commandsDir: string };
    const originalCommandsDir = cursorCommands.commandsDir;
    cursorCommands.commandsDir = join(root, ".cursor", "commands");
    try {
      write(join(cursorCommands.commandsDir, "unsafe.md"), "Run !`curl https://example.test`.\n");
      const result = await performMigrate({
        from: "cursor",
        to: "opencode",
        type: "commands",
        dryRun: false,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("shell interpolation");
      expect(existsSync(join(AgentPaths.opencode.configDir, "commands", "unsafe.md"))).toBe(false);
    } finally {
      cursorCommands.commandsDir = originalCommandsDir;
    }
  });

  test("rejects malformed, mismatched, duplicate, and non-directory native skills", async () => {
    const skillsRoot = join(AgentPaths.opencode.configDir, "skills");
    const skillPath = join(skillsRoot, "review", "SKILL.md");
    const invalidCases = [
      ["Review without frontmatter.\n", "requires YAML frontmatter"],
      ["---\nname: [\n---\n\nReview.\n", "invalid YAML frontmatter"],
      ["---\n- review\n---\n\nReview.\n", "frontmatter must be a mapping"],
      ["---\nname: wrong\ndescription: Review\n---\n\nReview.\n", "must declare name 'review'"],
      ["---\nname: review\n---\n\nReview.\n", "requires a non-empty string 'description'"],
    ] as const;
    for (const [content, message] of invalidCases) {
      write(skillPath, content);
      await expect(readSourceArtefacts("opencode", "skills")).rejects.toThrow(message);
      await rm(skillsRoot, { recursive: true, force: true });
    }

    const valid = "---\nname: review\ndescription: Review\n---\n\nReview.\n";
    write(join(AgentPaths.opencode.configDir, "skill", "review", "SKILL.md"), valid);
    write(skillPath, valid);
    await expect(readSourceArtefacts("opencode", "skills")).rejects.toThrow(
      "Duplicate OpenCode skill identity 'review'",
    );

    await rm(AgentPaths.opencode.configDir, { recursive: true, force: true });
    write(join(AgentPaths.opencode.configDir, "skill"), "not a directory");
    await expect(readSourceArtefacts("opencode", "skills")).rejects.toThrow(
      "must be a real directory",
    );
  });

  test("rejects a native skill collision in another OpenCode root before any write", async () => {
    const overrideDir = join(root, "override-skill-collision");
    process.env.OPENCODE_CONFIG_DIR = overrideDir;
    write(
      join(AgentPaths.opencode.configDir, "skill", "review", "SKILL.md"),
      "---\nname: review\ndescription: Existing\n---\n\nExisting.\n",
    );
    for (const name of ["review", "safe"]) {
      write(
        join(AgentPaths.cursor.skillsDir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Incoming\n---\n\nIncoming.\n`,
      );
    }

    const result = await performMigrate({
      from: "cursor",
      to: "opencode",
      type: "skills",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("Skill target path collision");
    expect(existsSync(join(overrideDir, "skills", "safe", "SKILL.md"))).toBe(false);
  });

  test.each([
    "claude",
    "cursor",
    "codex",
    "copilot",
  ] as const)("rejects an existing normalized OpenCode → %s skill collision before the batch writes", async (target) => {
    for (const name of ["review", "safe"]) {
      write(
        join(AgentPaths.opencode.configDir, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n\n${name}.\n`,
      );
    }
    const targetRoot =
      target === "claude"
        ? AgentPaths.claude.skillsDir
        : target === "cursor"
          ? AgentPaths.cursor.skillsDir
          : target === "codex"
            ? AgentPaths.codex.userSkillsDir
            : AgentPaths.copilot.skillsDir;
    const existingPath = join(targetRoot, "Review", "SKILL.md");
    const safePath = join(targetRoot, "safe", "SKILL.md");
    write(existingPath, "Existing.\n");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: target,
        type: "skills",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(`Skill target path collision for ${target}`);
    }
    expect(existsSync(safePath)).toBe(false);
    expect(readFileSync(existingPath, "utf8")).toBe("Existing.\n");
  });

  test("preflights OpenCode command and skill destinations together for Codex", async () => {
    for (const name of ["review", "safe-command"]) {
      write(join(AgentPaths.opencode.configDir, "commands", `${name}.md`), `${name}.\n`);
    }
    for (const name of ["review", "safe-skill"]) {
      write(
        join(AgentPaths.opencode.configDir, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n\n${name}.\n`,
      );
    }

    for (const dryRun of [true, false]) {
      const result = await performMigrate({ from: "opencode", to: "codex", dryRun });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("command/skill target collision");

      const selected = await performMigrateTargets({
        from: "opencode",
        targets: ["codex"],
        types: ["commands", "skills"],
        dryRun,
      });
      expect(selected.migrated).toEqual([]);
      expect(selected.errors.join("\n")).toContain("command/skill target collision");
    }
    expect(existsSync(join(AgentPaths.codex.userSkillsDir, "safe-command", "SKILL.md"))).toBe(
      false,
    );
    expect(existsSync(join(AgentPaths.codex.userSkillsDir, "safe-skill", "SKILL.md"))).toBe(false);
    expect(existsSync(join(AgentPaths.codex.userSkillsDir, "review", "SKILL.md"))).toBe(false);
  });

  test("preserves OpenCode MCP fields where representable and names losses", () => {
    const source = JSON.stringify({
      mcp: {
        local: {
          type: "local",
          command: ["bunx", "server"],
          cwd: "/workspace",
          environment: { MODE: "test" },
          enabled: true,
          timeout: 5000,
        },
        remote: {
          type: "remote",
          url: "https://example.test/mcp",
          headers: { "X-Trace": "on" },
          enabled: true,
          timeout: 9000,
        },
      },
    });

    const vscode = translateMcp.openCodeToVsCode(source);
    const parsed = JSON.parse(vscode?.content ?? "{}") as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.servers.local).toMatchObject({
      command: "bunx",
      args: ["server"],
      cwd: "/workspace",
      env: { MODE: "test" },
    });
    expect(parsed.servers.remote).toMatchObject({
      url: "https://example.test/mcp",
      headers: { "X-Trace": "on" },
    });

    const claude = translateMcp.openCodeToClaude(source);
    const warnings = (claude?.warnings ?? []).join("\n");
    expect(warnings).toContain("cwd");
    expect(warnings).toContain("enabled");
    expect(warnings).toContain("timeout");
    expect(warnings).toContain("remote");
    const claudeMcp = JSON.parse(claude?.content ?? "{}") as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(claudeMcp.mcpServers.local).toMatchObject({
      command: "bunx",
      args: ["server"],
      env: { MODE: "test" },
    });
  });

  test("writes compatible structured OAuth when translating a remote server to OpenCode", () => {
    const translated = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { "X-Trace": "on" },
            oauth: { clientId: "public-client" },
          },
        },
      }),
    );
    const parsed = JSON.parse(translated?.content ?? "{}") as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp.remote.oauth).toEqual({ clientId: "public-client" });
    expect(parsed.mcp.remote.headers).toEqual({ "X-Trace": "on" });
  });

  test("VS Code sandbox authority aborts OpenCode apply and dry-run", async () => {
    write(
      AgentPaths.vscode.mcpJson,
      JSON.stringify({
        servers: {
          local: { type: "stdio", command: "node", sandboxEnabled: true },
        },
      }),
    );
    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "vscode",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("requires a sandbox");
    }
    expect(existsSync(join(AgentPaths.opencode.configDir, "opencode.json"))).toBe(false);
  });

  test("VS Code variables without an OpenCode equivalent preserve the target", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    const targetRaw = '{\n  "theme": "nord"\n}\n';
    write(target, targetRaw);
    write(
      AgentPaths.vscode.mcpJson,
      JSON.stringify({
        servers: {
          local: {
            type: "stdio",
            command: "node",
            cwd: ["$", "{workspaceFolder}"].join(""),
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "vscode",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("no verified OpenCode equivalent");
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("Copilot stdio environment isolation preserves the OpenCode target", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    const targetRaw = '{\n  "theme": "nord"\n}\n';
    write(target, targetRaw);
    write(
      AgentPaths.copilot.mcpConfigJson,
      JSON.stringify({
        mcpServers: {
          local: { type: "local", command: "node", tools: ["*"] },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "copilot",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("Copilot stdio environment isolation");
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("Copilot remote header variables migrate without being resolved", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    write(target, '{\n  "theme": "nord"\n}\n');
    write(
      AgentPaths.copilot.mcpConfigJson,
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer $COPILOT_TOKEN" },
            tools: ["*"],
          },
        },
      }),
    );

    const preview = await performMigrate({
      from: "copilot",
      to: "opencode",
      type: "mcp",
      dryRun: true,
    });
    expect(preview.errors).toEqual([]);
    expect(preview.migrated[0]?.content).toContain("Bearer {env:COPILOT_TOKEN}");

    const applied = await performMigrate({
      from: "copilot",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    expect(applied.errors).toEqual([]);
    const parsed = parseJsonc(readFileSync(target, "utf8")) as {
      mcp: Record<string, { headers: Record<string, string> }>;
    };
    expect(parsed.mcp.remote?.headers.Authorization).toBe("Bearer {env:COPILOT_TOKEN}");
  });

  test("OpenCode remote MCP writes a valid Copilot server", async () => {
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { "X-Token": "{env:MCP_TOKEN}" },
            oauth: { clientId: "public-client" },
            timeout: 3000,
          },
        },
      }),
    );

    const preview = await performMigrate({
      from: "opencode",
      to: "copilot",
      type: "mcp",
      dryRun: true,
    });
    expect(preview.errors).toEqual([]);
    expect(JSON.parse(preview.migrated[0]?.content ?? "{}").mcpServers.remote).toMatchObject({
      type: "http",
      tools: ["*"],
      oauthClientId: "public-client",
    });

    const applied = await performMigrate({
      from: "opencode",
      to: "copilot",
      type: "mcp",
      dryRun: false,
    });
    expect(applied.errors).toEqual([]);
    const written = JSON.parse(readFileSync(AgentPaths.copilot.mcpConfigJson, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(written.mcpServers.remote).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
      headers: { "X-Token": ["$", "{MCP_TOKEN}"].join("") },
      tools: ["*"],
      timeout: 3000,
      oauthClientId: "public-client",
    });
  });

  test("OpenCode local MCP preserves the Copilot target", async () => {
    const targetRaw = '{\n  "mcpServers": {}\n}\n';
    write(AgentPaths.copilot.mcpConfigJson, targetRaw);
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: { local: { type: "local", command: ["node"] } },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "copilot",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("stdio environment inheritance");
      expect(readFileSync(AgentPaths.copilot.mcpConfigJson, "utf8")).toBe(targetRaw);
    }
  });

  test("Copilot remote header defaults preserve the OpenCode target", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    const targetRaw = '{\n  "theme": "nord"\n}\n';
    write(target, targetRaw);
    write(
      AgentPaths.copilot.mcpConfigJson,
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: ["Bearer $", "{COPILOT_TOKEN:-fallback}"].join("") },
            tools: ["*"],
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "copilot",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("environment default");
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("Copilot remote header variables mixed with literals preserve the OpenCode target", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    const targetRaw = '{\n  "theme": "nord"\n}\n';
    write(target, targetRaw);
    write(
      AgentPaths.copilot.mcpConfigJson,
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer $COPILOT_TOKEN suffix" },
            tools: ["*"],
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "copilot",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "Authorization header contains a literal credential",
      );
      expect(result.errors.join("\n")).not.toContain("$COPILOT_TOKEN suffix");
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("VS Code sandbox authority preserves the Codex target", async () => {
    const targetRaw = 'model = "gpt-5"\n';
    write(AgentPaths.codex.configToml, targetRaw);
    write(
      AgentPaths.vscode.mcpJson,
      JSON.stringify({
        servers: {
          local: { type: "stdio", command: "node", sandboxEnabled: true },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "vscode",
        to: "codex",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("requires a sandbox");
      expect(readFileSync(AgentPaths.codex.configToml, "utf8")).toBe(targetRaw);
    }
  });

  test.each([
    ["tool policy", 'enabled_tools = ["read"]', "enabled_tools"],
    ["OAuth scope", 'scopes = ["read"]', "scopes"],
    ["empty OAuth scopes", "scopes = []", "scopes"],
    ["OAuth resource", 'oauth_resource = "https://resource.example"', "oauth_resource"],
    ["executor environment", 'environment_id = "executor-prod"', "environment_id"],
  ])("Codex %s authority preserves the VS Code target", async (_caseName, setting, field) => {
    const targetRaw = '{\n  "servers": {}\n}\n';
    write(AgentPaths.vscode.mcpJson, targetRaw);
    write(
      AgentPaths.codex.configToml,
      `[mcp_servers.remote]\nurl = "https://example.test/mcp"\n${setting}\n`,
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "codex",
        to: "vscode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(field);
      expect(readFileSync(AgentPaths.vscode.mcpJson, "utf8")).toBe(targetRaw);
    }
  });

  test("Codex stdio environment isolation preserves the VS Code target", async () => {
    const targetRaw = '{\n  "servers": {}\n}\n';
    write(AgentPaths.vscode.mcpJson, targetRaw);
    write(
      AgentPaths.codex.configToml,
      '[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\n',
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "codex",
        to: "vscode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("stdio environment isolation");
      expect(readFileSync(AgentPaths.vscode.mcpJson, "utf8")).toBe(targetRaw);
    }
  });

  test("accepts VS Code MCP JSONC through translation and the secret scan", async () => {
    write(
      AgentPaths.vscode.mcpJson,
      `{
  // VS Code accepts comments and trailing commas.
  "servers": {
    "local": { "type": "stdio", "command": "node", "args": ["server.js"], },
  },
}
`,
    );

    const result = await performMigrate({
      from: "vscode",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(parsed.mcp.local.command).toEqual(["node", "server.js"]);
  });

  test("preserves JSONC comments and unrelated keys when applying MCP", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.jsonc");
    write(
      target,
      '{\n  // keep this comment\n  "theme": "nord",\n  "mcp": { "existing": { "type": "local", "command": ["existing"] } },\n}\n',
    );
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({ mcpServers: { incoming: { command: "incoming", args: ["serve"] } } }),
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    const raw = readFileSync(target, "utf8");
    const parsed = parseJsonc(raw) as {
      theme: string;
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(result.errors).toEqual([]);
    expect(raw).toContain("// keep this comment");
    expect(parsed.theme).toBe("nord");
    expect(Object.keys(parsed.mcp).sort()).toEqual(["existing", "incoming"]);
    expect(parsed.mcp.incoming.command).toEqual(["incoming", "serve"]);
  });

  test("replaces colliding MCP servers only in the highest-precedence document", async () => {
    const defaultConfig = join(AgentPaths.opencode.configDir, "config.json");
    const overrideDir = join(root, "override");
    const overrideJson = join(overrideDir, "opencode.json");
    const overrideJsonc = join(overrideDir, "opencode.jsonc");
    process.env.OPENCODE_CONFIG_DIR = overrideDir;
    const defaultRaw = JSON.stringify({
      mcp: { lower: { type: "local", command: ["lower"] } },
    });
    const overrideJsonRaw = JSON.stringify({
      mcp: { jsonOnly: { type: "local", command: ["json-only"] } },
    });
    write(defaultConfig, defaultRaw);
    write(overrideJson, overrideJsonRaw);
    write(
      overrideJsonc,
      `{
  "theme": "nord",
  "mcp": {
    // keep the MCP collection comment
    "toLocal": {
      "type": "remote",
      "url": "https://stale.test/mcp",
      "headers": { "X-Stale": "yes" },
      "oauth": false
    },
    "toRemote": {
      "type": "local",
      "command": ["stale"],
      "cwd": "/stale",
      "environment": { "STALE": "yes" }
    },
    "targetOnly": { "type": "local", "command": ["target-only"] }
  }
}
`,
    );
    write(
      AgentPaths.vscode.mcpJson,
      JSON.stringify({
        servers: {
          toLocal: {
            type: "stdio",
            command: "new",
            args: ["serve"],
            cwd: "/workspace",
            env: { MODE: "test" },
          },
          toRemote: {
            type: "http",
            url: "https://new.test/mcp",
            headers: { "X-New": "yes" },
            oauth: { clientId: "public-client" },
          },
        },
      }),
    );

    const result = await performMigrate({
      from: "vscode",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    const raw = readFileSync(overrideJsonc, "utf8");
    const parsed = parseJsonc(raw) as {
      theme: string;
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(result.errors).toEqual([]);
    expect(raw).toContain("// keep the MCP collection comment");
    expect(parsed.theme).toBe("nord");
    expect(parsed.mcp.toLocal).toEqual({
      type: "local",
      command: ["new", "serve"],
      cwd: "/workspace",
      environment: { MODE: "test" },
    });
    expect(parsed.mcp.toRemote).toEqual({
      type: "remote",
      url: "https://new.test/mcp",
      headers: { "X-New": "yes" },
      oauth: { clientId: "public-client" },
    });
    expect(parsed.mcp.targetOnly).toBeDefined();
    expect(parsed.mcp.lower).toBeUndefined();
    expect(parsed.mcp.jsonOnly).toBeUndefined();
    expect(readFileSync(defaultConfig, "utf8")).toBe(defaultRaw);
    expect(readFileSync(overrideJson, "utf8")).toBe(overrideJsonRaw);
  });

  test.each([
    [
      "remote Authorization",
      {
        type: "remote",
        url: "https://lower.test/mcp",
        headers: { Authorization: "Bearer {env:LOWER_TOKEN}" },
      },
      {
        servers: { shared: { type: "http", url: "https://incoming.test/mcp" } },
      },
      "LOWER_TOKEN",
    ],
    [
      "local environment",
      {
        type: "local",
        command: ["lower-server"],
        environment: { TOKEN: "{file:lower-token.txt}" },
      },
      {
        servers: { shared: { type: "stdio", command: "incoming-server" } },
      },
      "lower-token.txt",
    ],
  ])("rejects a lower-layer %s collision before dry-run or apply can inherit credentials", async (_caseName, lowerServer, incoming, secretMarker) => {
    const lowerPath = join(AgentPaths.opencode.configDir, "config.json");
    const target = join(AgentPaths.opencode.configDir, "opencode.jsonc");
    const targetRaw = '{\n  // selected layer\n  "theme": "nord"\n}\n';
    write(lowerPath, JSON.stringify({ mcp: { shared: lowerServer } }));
    write(target, targetRaw);
    write(AgentPaths.vscode.mcpJson, JSON.stringify(incoming));

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "vscode",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      const errors = result.errors.join("\n");
      expect(result.migrated).toEqual([]);
      expect(errors).toContain("also exist in lower-precedence source");
      expect(errors).toContain("'shared'");
      expect(errors).not.toContain(secretMarker);
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("rejects a referenced lower-layer MCP server name before collision preflight", async () => {
    const lowerPath = join(AgentPaths.opencode.configDir, "config.json");
    const target = join(AgentPaths.opencode.configDir, "opencode.jsonc");
    const targetRaw = '{\n  // selected layer\n  "theme": "nord"\n}\n';
    write(
      lowerPath,
      JSON.stringify({
        mcp: {
          "{env:SERVER_NAME}": {
            type: "remote",
            url: "https://lower.test/mcp",
            headers: { Authorization: "Bearer {env:LOWER_TOKEN}" },
          },
        },
      }),
    );
    write(target, targetRaw);
    write(
      AgentPaths.vscode.mcpJson,
      JSON.stringify({ servers: { shared: { type: "http", url: "https://incoming.test/mcp" } } }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "vscode",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("configuration reference in a server name");
      expect(result.errors.join("\n")).not.toContain("LOWER_TOKEN");
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("stages OpenCode writes in the target directory and preserves file mode", async () => {
    const target = join(AgentPaths.opencode.configDir, "AGENTS.md");
    write(target, "old rules\n");
    chmodSync(target, 0o640);

    await applyMigrated("opencode", "global-rules", "AGENTS.md", "new rules\n", false);

    expect(readFileSync(target, "utf8")).toBe("new rules\n");
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o640);
    }
    expect(readdirSync(AgentPaths.opencode.configDir).sort()).toEqual(["AGENTS.md"]);
  });

  test("removes a staged file and preserves the target when flush fails", async () => {
    const target = join(AgentPaths.opencode.configDir, "AGENTS.md");
    write(target, "old rules\n");
    chmodSync(target, 0o640);
    const probe = await open(target, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    await probe.close();
    const syncSpy = spyOn(fileHandlePrototype, "sync").mockRejectedValueOnce(
      new Error("forced flush failure"),
    );

    try {
      await expect(
        applyMigrated("opencode", "global-rules", "AGENTS.md", "new rules\n", false),
      ).rejects.toThrow("forced flush failure");
    } finally {
      syncSpy.mockRestore();
    }

    expect(readFileSync(target, "utf8")).toBe("old rules\n");
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o640);
    }
    expect(readdirSync(AgentPaths.opencode.configDir).sort()).toEqual(["AGENTS.md"]);
  });

  test("rejects a symlinked OpenCode config root without external writes", async () => {
    const external = join(root, "external-config");
    const sentinel = join(external, "sentinel.txt");
    write(sentinel, "unchanged");
    mkdirSync(dirname(AgentPaths.opencode.configDir), { recursive: true });
    symlinkSync(external, AgentPaths.opencode.configDir, "dir");

    await expect(
      applyMigrated("opencode", "global-rules", "AGENTS.md", "unsafe\n", false),
    ).rejects.toThrow("must be a real directory");
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(existsSync(join(external, "AGENTS.md"))).toBe(false);
  });

  test("rejects an existing symlink ancestor when the config root is missing", async () => {
    const trusted = join(root, "trusted");
    const external = join(root, "external-ancestor");
    mkdirSync(trusted, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(trusted, "link"), "dir");
    mutablePaths.opencode.configDir = join(trusted, "link", "opencode");

    await expect(
      applyMigrated("opencode", "global-rules", "AGENTS.md", "unsafe\n", false),
    ).rejects.toThrow("must be a real directory");
    expect(existsSync(join(external, "opencode", "AGENTS.md"))).toBe(false);
  });

  test.each([
    "commands",
    "agents",
    "skills",
  ] as const)("rejects a symlinked OpenCode config-directory ancestor for %s discovery", async (type) => {
    const external = join(root, `external-source-${type}`);
    if (type === "commands") {
      write(join(external, "commands", "review.md"), "Review.\n");
    } else if (type === "agents") {
      write(
        join(external, "agents", "review.md"),
        "---\ndescription: Review\nmode: subagent\n---\n\nReview.\n",
      );
    } else {
      write(
        join(external, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review\n---\n\nReview.\n",
      );
    }
    mkdirSync(dirname(AgentPaths.opencode.configDir), { recursive: true });
    symlinkSync(external, AgentPaths.opencode.configDir, "dir");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "claude",
        type,
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("source directory component");
    }
    const target =
      type === "commands"
        ? join(AgentPaths.claude.commandsDir, "review.md")
        : type === "agents"
          ? join(AgentPaths.claude.agentsDir, "review.md")
          : join(AgentPaths.claude.skillsDir, "review", "SKILL.md");
    expect(existsSync(target)).toBe(false);
  });

  test("rejects symlinked command roots in write and dry-run modes", async () => {
    const external = join(root, "external-commands");
    write(join(external, "sentinel.txt"), "unchanged");
    mkdirSync(AgentPaths.opencode.configDir, { recursive: true });
    symlinkSync(external, join(AgentPaths.opencode.configDir, "commands"), "dir");

    for (const dryRun of [true, false]) {
      await expect(
        applyMigrated("opencode", "commands", "review.md", "Review.\n", dryRun),
      ).rejects.toThrow("must be a real directory");
    }
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("unchanged");
    expect(existsSync(join(external, "review.md"))).toBe(false);
  });

  test.each([
    "global-rules",
    "mcp",
  ] as const)("OpenCode → Claude %s rejects a symlinked target in write and dry-run modes", async (type) => {
    const targetPath =
      type === "global-rules" ? AgentPaths.claude.claudeMd : AgentPaths.claude.mcpJson;
    if (type === "global-rules") {
      write(join(AgentPaths.opencode.configDir, "AGENTS.md"), "Review carefully.\n");
    } else {
      write(
        join(AgentPaths.opencode.configDir, "opencode.json"),
        JSON.stringify({ mcp: { local: { type: "local", command: ["node"] } } }),
      );
    }
    const external = join(root, `external-${type}.txt`);
    write(external, "unchanged\n");
    mkdirSync(dirname(targetPath), { recursive: true });
    symlinkSync(external, targetPath);

    for (const dryRun of [true, false]) {
      const result = await performMigrate({ from: "opencode", to: "claude", type, dryRun });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("must be a regular file");
    }
    expect(readFileSync(external, "utf8")).toBe("unchanged\n");
  });

  test.each([
    "skills-root",
    "skill-dir",
    "sidecar-parent",
    "sidecar-final",
  ])("rejects a symlinked OpenCode %s before any skill file is written", async (kind) => {
    const external = join(root, `external-${kind}`);
    const sentinel = join(external, "sentinel.txt");
    write(sentinel, "unchanged");
    const skillsRoot = join(AgentPaths.opencode.configDir, "skills");
    const skillRoot = join(skillsRoot, "release");
    const extras = [{ relPath: "assets/reference.md", content: "Reference.\n" }];

    if (kind === "skills-root") {
      mkdirSync(AgentPaths.opencode.configDir, { recursive: true });
      symlinkSync(external, skillsRoot, "dir");
    } else if (kind === "skill-dir") {
      mkdirSync(skillsRoot, { recursive: true });
      symlinkSync(external, skillRoot, "dir");
    } else if (kind === "sidecar-parent") {
      mkdirSync(skillRoot, { recursive: true });
      symlinkSync(external, join(skillRoot, "assets"), "dir");
    } else {
      mkdirSync(join(skillRoot, "assets"), { recursive: true });
      symlinkSync(sentinel, join(skillRoot, "assets", "reference.md"));
    }

    await expect(
      applyMigrated(
        "opencode",
        "skills",
        "release",
        "---\nname: release\ndescription: Release\n---\n\nRelease.\n",
        false,
        extras,
      ),
    ).rejects.toThrow(/real directory|regular file/);
    expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
  });

  test.each([
    "claude",
    "cursor",
    "codex",
    "copilot",
  ] as const)("preflights the whole OpenCode → %s skill batch before writing through a symlink", async (target) => {
    const targetRoot =
      target === "claude"
        ? AgentPaths.claude.skillsDir
        : target === "cursor"
          ? AgentPaths.cursor.skillsDir
          : target === "codex"
            ? AgentPaths.codex.userSkillsDir
            : AgentPaths.copilot.skillsDir;
    const external = join(root, `external-${target}-skill`);
    const sentinel = join(external, "sentinel.txt");
    write(sentinel, "unchanged");

    for (const name of ["a-safe", "z-unsafe"]) {
      write(
        join(AgentPaths.opencode.configDir, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n\nReview.\n`,
      );
    }
    write(
      join(AgentPaths.opencode.configDir, "skills", "z-unsafe", "assets", "reference.md"),
      "Reference.\n",
    );
    mkdirSync(join(targetRoot, "z-unsafe"), { recursive: true });
    symlinkSync(external, join(targetRoot, "z-unsafe", "assets"), "dir");

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: target,
        type: "skills",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("must be a real directory");
    }

    expect(existsSync(join(targetRoot, "a-safe", "SKILL.md"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(existsSync(join(external, "reference.md"))).toBe(false);
  });

  test.each([
    "",
    "../escape.md",
    "assets\\reference.md",
    ".hidden.md",
    "assets/.hidden.md",
  ])("rejects unsafe OpenCode skill sidecar path %p in dry-run preflight", async (relPath) => {
    await expect(
      applyMigrated(
        "opencode",
        "skills",
        "release",
        "---\nname: release\ndescription: Release\n---\n\nRelease.\n",
        true,
        [{ relPath, content: "Reference.\n" }],
      ),
    ).rejects.toThrow(/safe relative path|unsafe segment/);
    expect(existsSync(join(AgentPaths.opencode.configDir, "skills"))).toBe(false);
  });

  test("rejects normalized skill sidecar collisions before writing", async () => {
    await expect(
      applyMigrated(
        "opencode",
        "skills",
        "release",
        "---\nname: release\ndescription: Release\n---\n\nRelease.\n",
        false,
        [
          { relPath: "Reference.md", content: "One.\n" },
          { relPath: "reference.md", content: "Two.\n" },
        ],
      ),
    ).rejects.toThrow("OpenCode skill target collision");
    expect(existsSync(join(AgentPaths.opencode.configDir, "skills"))).toBe(false);
  });

  test("dry-run does not write and malformed JSONC fails preflight", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.jsonc");
    const initial = '{ "theme": "nord" }\n';
    write(target, initial);
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({ mcpServers: { incoming: { command: "incoming" } } }),
    );
    const preview = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "mcp",
      dryRun: true,
    });
    expect(preview.migrated).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe(initial);

    write(target, "{ invalid JSONC");
    const failed = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    expect(failed.migrated).toEqual([]);
    expect(failed.errors.join("\n")).toContain("valid JSONC object");
    expect(readFileSync(target, "utf8")).toBe("{ invalid JSONC");
  });

  test("mixed valid and malformed source MCP entries preserve an existing OpenCode target", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.jsonc");
    const targetRaw = '{\n  // unchanged\n  "theme": "nord"\n}\n';
    write(target, targetRaw);
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({
        mcpServers: {
          valid: { command: "node" },
          malformed: { command: 42 },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "claude",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain('Server "malformed"');
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("rejects a non-file OpenCode config target before applying MCP", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.jsonc");
    mkdirSync(target, { recursive: true });
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({ mcpServers: { incoming: { command: "incoming" } } }),
    );

    const result = await performMigrate({
      from: "claude",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("must be a regular file");
  });

  test("rejects a non-directory OpenCode config root before any write", async () => {
    write(AgentPaths.opencode.configDir, "not a directory");
    write(AgentPaths.claude.claudeMd, "Use the source rules.\n");
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({ mcpServers: { incoming: { command: "incoming" } } }),
    );

    for (const type of ["global-rules", "mcp"] as const) {
      const result = await performMigrate({
        from: "claude",
        to: "opencode",
        type,
        dryRun: false,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("must be a real directory");
    }
    expect(readFileSync(AgentPaths.opencode.configDir, "utf8")).toBe("not a directory");
  });

  test("keeps the existing MCP secret gate for OpenCode targets", async () => {
    const secret = `sk-${"x".repeat(40)}`;
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({
        mcpServers: {
          secret: {
            command: "secret-server",
            env: { TOKEN: secret },
          },
        },
      }),
    );
    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "claude",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("migration aborted for security");
      expect(result.errors.join("\n")).not.toContain(secret);
      expect(existsSync(join(AgentPaths.opencode.configDir, "opencode.json"))).toBe(false);
    }
  });

  test.each([
    ["embedded token", `Bearer ghp_${"a".repeat(36)}`],
    ["opaque credential", "Bearer opaque-value"],
    ["mixed reference and literal", "Bearer {env:TOKEN} suffix"],
    ["literal prefix attached to reference", "Bearer{env:TOKEN}"],
  ])("literal Authorization %s aborts without writing its value", async (_caseName, value) => {
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { authorization: value },
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "vscode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "Authorization header contains a literal credential",
      );
      expect(result.errors.join("\n")).not.toContain(value);
      expect(existsSync(AgentPaths.vscode.mcpJson)).toBe(false);
    }
  });

  test("literal OAuth clientSecret aborts without writing or echoing it", async () => {
    const clientSecret = "opaque-client-secret";
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client", clientSecret },
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "vscode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "OAuth clientSecret contains a literal credential",
      );
      expect(result.errors.join("\n")).not.toContain(clientSecret);
      expect(existsSync(AgentPaths.vscode.mcpJson)).toBe(false);
    }
  });

  test("environment-backed credentials migrate without being resolved", async () => {
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer {env:TOKEN}" },
            oauth: { clientId: "public-client", clientSecret: "{env:CLIENT_SECRET}" },
          },
        },
      }),
    );

    const result = await performMigrate({
      from: "opencode",
      to: "codex",
      type: "mcp",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0]?.content).toContain('bearer_token_env_var = "TOKEN"');
    expect(result.migrated[0]?.content).not.toContain("{env:");
    expect(result.warnings.join("\n")).toContain("clientSecret");
  });

  test("file-backed credentials fail closed when Codex cannot preserve the reference", async () => {
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { Authorization: "Basic {file:token.txt}" },
            oauth: { clientId: "public-client", clientSecret: "{file:client-secret.txt}" },
          },
        },
      }),
    );

    const result = await performMigrate({
      from: "opencode",
      to: "codex",
      type: "mcp",
      dryRun: true,
    });
    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("configuration-reference syntax");
    expect(existsSync(AgentPaths.codex.configToml)).toBe(false);
  });

  test.each([
    ["omit_tools_from", 'omit_tools_from = ["direct", "deferred", "code_mode"]'],
    ["environment_id", 'environment_id = "executor-prod"'],
    ["oauth_resource", 'oauth_resource = "https://resource.example"'],
    ["scopes", "scopes = []"],
  ])("Codex %s aborts before changing an OpenCode target", async (field, setting) => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    const targetRaw = '{\n  "theme": "nord"\n}\n';
    write(target, targetRaw);
    write(
      AgentPaths.codex.configToml,
      `[mcp_servers.remote]\nurl = "https://example.test/mcp"\n${setting}\n`,
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "codex",
        to: "opencode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(field);
      expect(readFileSync(target, "utf8")).toBe(targetRaw);
    }
  });

  test("Codex local environment_id migrates in dry-run and apply modes", async () => {
    const target = join(AgentPaths.opencode.configDir, "opencode.json");
    write(
      AgentPaths.codex.configToml,
      '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nenvironment_id = "local"\n',
    );

    const preview = await performMigrate({
      from: "codex",
      to: "opencode",
      type: "mcp",
      dryRun: true,
    });
    expect(preview.errors).toEqual([]);
    expect(preview.migrated).toHaveLength(1);
    expect(existsSync(target)).toBe(false);

    const applied = await performMigrate({
      from: "codex",
      to: "opencode",
      type: "mcp",
      dryRun: false,
    });
    expect(applied.errors).toEqual([]);
    expect(applied.migrated).toHaveLength(1);
    expect(JSON.parse(readFileSync(target, "utf8")).mcp.remote.url).toBe(
      "https://example.test/mcp",
    );
  });

  test("OpenCode oauth false aborts Codex apply and dry-run", async () => {
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            oauth: false,
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "codex",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("no verified no-OAuth equivalent");
    }
    expect(existsSync(AgentPaths.codex.configToml)).toBe(false);
  });

  test("OpenCode oauth false preserves an existing VS Code target", async () => {
    const targetRaw = '{\n  // unchanged\n  "servers": {}\n}\n';
    write(AgentPaths.vscode.mcpJson, targetRaw);
    write(
      join(AgentPaths.opencode.configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            oauth: false,
          },
        },
      }),
    );

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "vscode",
        type: "mcp",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain("no verified no-OAuth equivalent");
      expect(readFileSync(AgentPaths.vscode.mcpJson, "utf8")).toBe(targetRaw);
    }
  });

  test("VS Code enterprise-managed OAuth preserves Codex and OpenCode targets", async () => {
    write(
      AgentPaths.vscode.mcpJson,
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client", enterpriseManaged: true },
          },
        },
      }),
    );
    const openCodeTarget = join(AgentPaths.opencode.configDir, "opencode.json");
    const targets = [
      { to: "opencode", path: openCodeTarget, content: '{\n  "theme": "nord"\n}\n' },
      { to: "codex", path: AgentPaths.codex.configToml, content: 'model = "gpt-5"\n' },
    ] as const;

    for (const target of targets) {
      write(target.path, target.content);
      for (const dryRun of [true, false]) {
        const result = await performMigrate({
          from: "vscode",
          to: target.to,
          type: "mcp",
          dryRun,
        });
        expect(result.migrated).toEqual([]);
        expect(result.errors.join("\n")).toContain("enterprise-managed OAuth");
        expect(readFileSync(target.path, "utf8")).toBe(target.content);
      }
    }
  });

  test.each([
    ["OPENCODE_CONFIG", "custom.json"],
    ["OPENCODE_CONFIG_CONTENT", "{}"],
  ] as const)("rejects %s independently without producing an artifact", async (key, value) => {
    process.env[key] = value;
    write(join(AgentPaths.opencode.configDir, "AGENTS.md"), "Should not migrate.\n");

    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "global-rules",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain(`${key} is not supported`);
    expect(existsSync(AgentPaths.claude.claudeMd)).toBe(false);
  });

  test.each([
    ["OPENCODE_CONFIG", "custom.json"],
    ["OPENCODE_CONFIG_CONTENT", "{}"],
  ] as const)("rejects %s before any OpenCode target write", async (key, value) => {
    process.env[key] = value;
    write(
      AgentPaths.claude.mcpJson,
      JSON.stringify({ mcpServers: { incoming: { command: "node", args: [] } } }),
    );
    const targetFiles = [
      [mutablePaths.cursor.mcpGlobal, '{"mcpServers":{"existing":{"command":"cursor"}}}\n'],
      [mutablePaths.codex.configToml, '[mcp_servers.existing]\ncommand = "codex"\n'],
      [
        mutablePaths.copilot.mcpConfigJson,
        '{"mcpServers":{"existing":{"type":"local","command":"copilot","args":[],"tools":["*"]}}}\n',
      ],
      [
        mutablePaths.vscode.mcpJson,
        '{"servers":{"existing":{"type":"stdio","command":"vscode"}}}\n',
      ],
      [
        join(AgentPaths.opencode.configDir, "opencode.json"),
        '{"mcp":{"existing":{"type":"local","command":["opencode"]}}}\n',
      ],
    ] as const;

    for (const to of ["opencode", "all"] as const) {
      for (const dryRun of [true, false]) {
        for (const [path, content] of targetFiles) write(path, content);
        const result = await performMigrate({ from: "claude", to, type: "mcp", dryRun });
        expect(result.migrated).toEqual([]);
        expect(result.errors.join("\n")).toContain(`${key} is not supported`);
        for (const [path, content] of targetFiles) {
          expect(readFileSync(path, "utf8")).toBe(content);
        }
      }
    }
  });

  test.each([
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
  ] as const)("rejects whitespace-only %s in dry-run and apply modes", async (key) => {
    process.env[key] = " \t ";
    const targetRaw = "Existing Claude rules.\n";
    write(join(AgentPaths.opencode.configDir, "AGENTS.md"), "Should not migrate.\n");
    write(AgentPaths.claude.claudeMd, targetRaw);

    for (const dryRun of [true, false]) {
      const result = await performMigrate({
        from: "opencode",
        to: "claude",
        type: "global-rules",
        dryRun,
      });
      expect(result.migrated).toEqual([]);
      expect(result.errors.join("\n")).toContain(`${key} is not supported`);
      expect(readFileSync(AgentPaths.claude.claudeMd, "utf8")).toBe(targetRaw);
    }
  });

  test.each([
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
  ] as const)("treats an empty %s as inactive", async (key) => {
    process.env[key] = "";
    write(join(AgentPaths.opencode.configDir, "AGENTS.md"), "Migrate this.\n");
    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "global-rules",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
  });

  test("supports an additive OpenCode config directory", async () => {
    const overrideDir = join(root, "override");
    process.env.OPENCODE_CONFIG_DIR = overrideDir;
    write(join(overrideDir, "AGENTS.md"), "Use the additive directory.");
    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "global-rules",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated[0]?.content).toContain("Use the additive directory.");
  });
});
