import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { __setPushAgentsForTesting, performPush } from "../../../commands/push";
import { computeSyncStatus } from "../../../commands/status";
import { AgentPaths, machineVaultRoot } from "../../../config/paths";
import { encryptString } from "../../../core/encryptor";
import { AGENTSYNC_HOME_PLACEHOLDER } from "../../../core/path-portability";
import * as tarModule from "../../../core/tar";
import { archiveDirectory, listArchiveEntries } from "../../../core/tar";
import {
  createAgeIdentity,
  createBareRepo,
  createMachineFixture,
  createTestAgentSyncConfig,
  createTmpDir,
  seedVaultRepo,
} from "../../../test-helpers/fixtures";
import { applySingleArtifact, runApplyPlan } from "../../_apply";
import { type AgentDefinition, Agents } from "../../registry";
import { buildOpenCodePlan, resolveManagedOpenCodeSourcePaths, snapshotOpenCode } from "..";
import { parseOpenCodeJsonc } from "../jsonc";

type MutableOpenCodePaths = { configDir: string; homeConfigDir: string };
type MutableExternalSkillPaths = { skillsDir: string; claudeMd: string };
type MutableCodexPaths = { userSkillsDir: string };

const openCodePaths = AgentPaths.opencode as MutableOpenCodePaths;
const claudePaths = AgentPaths.claude as MutableExternalSkillPaths;
const codexPaths = AgentPaths.codex as MutableCodexPaths;
const originalOpenCode = { ...openCodePaths };
const originalClaudeSkills = claudePaths.skillsDir;
const originalClaudeMd = claudePaths.claudeMd;
const originalCodexSkills = codexPaths.userSkillsDir;
const originalLstat = fsPromises.lstat;
const ENVIRONMENT_KEYS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_PERMISSION",
  "OPENCODE_DISABLE_AUTOCOMPACT",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_TEST_MANAGED_CONFIG_DIR",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "OPENCODE_TEST_HOME",
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
);

let root = "";
let defaultRoot = "";
let customRoot = "";
let managedPreferencesLstatSpy: { mockRestore(): void } | undefined;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function skill(name: string, description = `${name} description`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

beforeEach(async () => {
  root = await createTmpDir();
  defaultRoot = join(root, "default-opencode");
  customRoot = join(root, "custom-opencode");
  openCodePaths.configDir = defaultRoot;
  openCodePaths.homeConfigDir = join(root, ".opencode");
  claudePaths.skillsDir = join(root, "external-claude-skills");
  claudePaths.claudeMd = join(root, "external-claude", "CLAUDE.md");
  codexPaths.userSkillsDir = join(root, "external-agent-skills");
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = join(root, "managed-opencode");
  if (process.platform === "darwin") {
    managedPreferencesLstatSpy = spyOn(fsPromises, "lstat").mockImplementation((async (
      path,
      options,
    ) => {
      if (String(path).startsWith("/Library/Managed Preferences/")) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return originalLstat(path, options);
    }) as typeof originalLstat);
  }
});

afterEach(async () => {
  managedPreferencesLstatSpy?.mockRestore();
  managedPreferencesLstatSpy = undefined;
  await rm(root, { recursive: true, force: true });
});

afterAll(() => {
  Object.assign(openCodePaths, originalOpenCode);
  claudePaths.skillsDir = originalClaudeSkills;
  claudePaths.claudeMd = originalClaudeMd;
  codexPaths.userSkillsDir = originalCodexSkills;
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("snapshotOpenCode", () => {
  test("preserves default/custom layers, recursive paths, active AGENTS.md, and skill sidecars", async () => {
    process.env.OPENCODE_CONFIG_DIR = customRoot;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";

    await put(
      join(defaultRoot, "opencode.jsonc"),
      `{\n  // keep config comment\n  "path": "${homedir()}/bin"\n}\n`,
    );
    await put(join(defaultRoot, "tui.json"), '{ "scroll_speed": 2 }\n');
    await put(join(customRoot, "opencode.json"), '{ "model": "openai/gpt-5" }\n');
    await put(join(customRoot, "tui.jsonc"), '{ "diff_style": "auto", }\n');
    await put(join(defaultRoot, "AGENTS.md"), "inactive default rules\n");
    await put(join(customRoot, "AGENTS.md"), "active custom rules\n");
    await put(join(defaultRoot, "command", "team", "review.md"), "# Review\n");
    await put(join(defaultRoot, "commands", "build.md"), "# Build\n");
    await put(join(customRoot, "agent", "reviewer.md"), "---\ndescription: Review\n---\n");
    await put(join(customRoot, "agents", "team", "tester.md"), "---\ndescription: Test\n---\n");
    await put(join(defaultRoot, "skills", "alpha", "SKILL.md"), skill("alpha"));
    await put(join(defaultRoot, "skills", "alpha", "references", "notes.md"), "notes\n");

    const result = await snapshotOpenCode(createTestAgentSyncConfig());
    const paths = result.artifacts.map((artifact) => artifact.vaultPath);
    expect(paths).toEqual([
      "opencode/custom/agent/reviewer.md.age",
      "opencode/custom/AGENTS.md.age",
      "opencode/custom/agents/team/tester.md.age",
      "opencode/custom/opencode.json.age",
      "opencode/custom/tui.jsonc.age",
      "opencode/default/command/team/review.md.age",
      "opencode/default/commands/build.md.age",
      "opencode/default/opencode.jsonc.age",
      "opencode/default/skills/alpha.tar.age",
      "opencode/default/tui.json.age",
    ]);

    const config = result.artifacts.find(
      (artifact) => artifact.vaultPath === "opencode/default/opencode.jsonc.age",
    );
    expect(config?.plaintext).toContain("// keep config comment");
    expect(config?.plaintext).toContain(`${AGENTSYNC_HOME_PLACEHOLDER}/bin`);
    expect(paths).not.toContain("opencode/default/AGENTS.md.age");

    const archived = result.artifacts.find(
      (artifact) => artifact.vaultPath === "opencode/default/skills/alpha.tar.age",
    );
    const entries = await listArchiveEntries(Buffer.from(archived?.plaintext ?? "", "base64"));
    expect(entries.map((entry) => entry.path).sort()).toEqual(["SKILL.md", "references/notes.md"]);
  });

  test("archives nested native skills independently without duplicating the child bundle", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "skill", "outer", "SKILL.md"), skill("outer"));
    await put(join(defaultRoot, "skill", "outer", "README.md"), "outer\n");
    await put(join(defaultRoot, "skill", "outer", "nested", "child", "SKILL.md"), skill("child"));
    await put(join(defaultRoot, "skill", "outer", "nested", "child", "asset.txt"), "child\n");

    const result = await snapshotOpenCode(createTestAgentSyncConfig());
    expect(result.artifacts.map((artifact) => artifact.vaultPath)).toEqual([
      "opencode/default/skill/outer.tar.age",
      "opencode/default/skill/outer/nested/child.tar.age",
    ]);
    const outer = result.artifacts.find((artifact) => artifact.vaultPath.endsWith("outer.tar.age"));
    const entries = await listArchiveEntries(Buffer.from(outer?.plaintext ?? "", "base64"));
    expect(entries.map((entry) => entry.path).sort()).toEqual(["README.md", "SKILL.md"]);
  });

  test.each([
    ["OPENCODE_CONFIG", " /tmp/custom.json "],
    ["OPENCODE_CONFIG_CONTENT", " {} "],
    ["OPENCODE_TUI_CONFIG", " /tmp/tui.json "],
    ["OPENCODE_PERMISSION", " {} "],
    ["OPENCODE_TEST_HOME", " /tmp/opencode-home "],
  ] as const)("rejects active %s", async (name, value) => {
    process.env[name] = value;
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(name);
  });

  test.each([
    "OPENCODE_TEST_HOME",
    "OPENCODE_CONFIG_DIR",
  ] as const)("rejects exported-empty %s", async (name) => {
    process.env[name] = "";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(name);
  });

  test("rejects active compaction overlays but permits inactive values", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    process.env.OPENCODE_DISABLE_AUTOCOMPACT = "TRUE";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "OPENCODE_DISABLE_AUTOCOMPACT",
    );
    process.env.OPENCODE_DISABLE_AUTOCOMPACT = "false";
    process.env.OPENCODE_DISABLE_PRUNE = "1";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "OPENCODE_DISABLE_PRUNE",
    );
    process.env.OPENCODE_DISABLE_PRUNE = "yes";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });
  });

  test("rejects malformed runtime Boolean flags", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "TRUE";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    );
  });

  test.each([
    ['{ "command": { "inline": { "template": "x" } } }', "inline 'command'"],
    ['{ "agent": { "inline": { "description": "x" } } }', "inline 'agent'"],
    ['{ "mode": { "plan": {} } }', "inline 'mode'"],
    ['{ "plugin": ["npm:danger"] }', "executable plugins"],
    ['{ "tools": { "bash": false } }', "theme or tool"],
    ['{ "theme": "dark" }', "theme or tool"],
    ['{ "instructions": ["outside.md"] }', "instruction sources"],
    ['{ "skills": { "urls": ["https://example.com/skill"] } }', "skill paths or URLs"],
    ['{ "mcp": { "x": { "command": "{file:/tmp/command}" } } }', "{file:...}"],
  ] as const)("rejects an unsupported source in config: %s", async (content, message) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "opencode.json"), content);
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(message);
  });

  test.each(["config.json", "config"])("rejects active legacy %s", async (name) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, name), "{}\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow("legacy config");
  });

  test("rejects active plugin and mode files without including dependency manifests", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "package.json"), '{ "dependencies": {} }\n');
    await put(join(defaultRoot, "plugin", "danger.ts"), "export default {}\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow("danger.ts");
    await rm(join(defaultRoot, "plugin"), { recursive: true });
    await put(join(defaultRoot, "modes", "plan.md"), "# plan\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow("plan.md");
  });

  test.each([
    ["tool", "custom.ts"],
    ["tools", "custom.js"],
    ["themes", "custom.json"],
  ] as const)("rejects an active global %s file", async (directory, filename) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, directory, filename), "export default {}\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(filename);
  });

  test("matches the pinned non-recursive tool and theme discovery", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "tools", "nested", "ignored.ts"), "export default {}\n");
    await put(join(defaultRoot, "themes", "nested", "ignored.json"), "{}\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });
  });

  test("accepts themes under the custom root because the pinned loader never reads them", async () => {
    process.env.OPENCODE_CONFIG_DIR = customRoot;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(customRoot, "themes", "inactive.json"), "{}\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });
  });

  test("rejects a symlinked active tool file", async () => {
    if (process.platform === "win32") return;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const outside = join(root, "outside-tool.ts");
    await put(outside, "export default {}\n");
    await mkdir(join(defaultRoot, "tools"), { recursive: true });
    await symlink(outside, join(defaultRoot, "tools", "linked.ts"));
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow("regular file");
  });

  test("rejects active external skills unless OpenCode external discovery is disabled", async () => {
    await put(join(codexPaths.userSkillsDir, "external", "SKILL.md"), skill("external"));
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "backs up only OpenCode-native skills",
    );
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });
  });

  test("follows only symlinks that lead to an external SKILL.md", async () => {
    if (process.platform === "win32") return;
    const harmless = join(root, "harmless-external");
    await put(join(harmless, "README.md"), "not a skill\n");
    await mkdir(codexPaths.userSkillsDir, { recursive: true });
    await symlink(harmless, join(codexPaths.userSkillsDir, "linked"));
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });

    await put(join(harmless, "nested", "SKILL.md"), skill("nested"));
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "backs up only OpenCode-native skills",
    );
  });

  test("rejects the fallback Claude prompt only when active AGENTS.md does not win", async () => {
    await put(claudePaths.claudeMd, "external instructions\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "external instructions",
    );

    process.env.OPENCODE_CONFIG_DIR = customRoot;
    await put(join(customRoot, "AGENTS.md"), "active OpenCode instructions\n");
    const snapshot = await snapshotOpenCode(createTestAgentSyncConfig());
    expect(snapshot.artifacts.map((artifact) => artifact.vaultPath)).toEqual([
      "opencode/custom/AGENTS.md.age",
    ]);

    await rm(join(customRoot, "AGENTS.md"));
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "true";
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });
  });

  test("rejects an observable managed filesystem config", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(root, "managed-opencode", "opencode.json"), "{}\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow("managed config");
  });

  test("calculates managed filesystem sources for every supported platform", () => {
    expect(resolveManagedOpenCodeSourcePaths("linux", {}, "alice")).toEqual([
      "/etc/opencode/opencode.json",
      "/etc/opencode/opencode.jsonc",
    ]);
    expect(
      resolveManagedOpenCodeSourcePaths("win32", { ProgramData: "D:\\ProgramData" }, "alice"),
    ).toEqual([
      "D:\\ProgramData\\opencode\\opencode.json",
      "D:\\ProgramData\\opencode\\opencode.jsonc",
    ]);
    expect(resolveManagedOpenCodeSourcePaths("darwin", {}, "alice")).toEqual([
      "/Library/Application Support/opencode/opencode.json",
      "/Library/Application Support/opencode/opencode.jsonc",
      "/Library/Managed Preferences/alice/ai.opencode.managed.plist",
      "/Library/Managed Preferences/ai.opencode.managed.plist",
    ]);
    expect(
      resolveManagedOpenCodeSourcePaths(
        "darwin",
        { OPENCODE_TEST_MANAGED_CONFIG_DIR: "/tmp/test-managed" },
        "alice",
      ),
    ).toEqual([
      "/tmp/test-managed/opencode.json",
      "/tmp/test-managed/opencode.jsonc",
      "/Library/Managed Preferences/alice/ai.opencode.managed.plist",
      "/Library/Managed Preferences/ai.opencode.managed.plist",
    ]);
  });

  test.each([
    ["config", "opencode.json", "{}\n"],
    ["TUI config", "tui.json", "{}\n"],
    ["TUI JSONC config", "tui.jsonc", "{}\n"],
    ["command", "commands/team/review.md", "# Review\n"],
    ["agent", "agents/reviewer.md", "---\ndescription: Review\n---\n"],
    ["mode", "modes/plan.md", "---\ndescription: Plan\n---\n"],
    ["plugin", "plugins/setup.ts", "export default {}\n"],
    ["tool", "tools/check.ts", "export default {}\n"],
    ["skill", "skills/review/SKILL.md", skill("review")],
  ])("rejects an active fixed-home OpenCode %s source", async (_kind, relativePath, content) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(root, ".opencode", ...relativePath.split("/")), content);

    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      join(root, ".opencode"),
    );
  });

  test("ignores inactive fixed-home dependency metadata", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(root, ".opencode", "package.json"), '{ "dependencies": {} }\n');
    await put(join(root, ".opencode", "node_modules", "package", "index.js"), "export {}\n");

    await expect(snapshotOpenCode(createTestAgentSyncConfig())).resolves.toEqual({
      artifacts: [],
      warnings: [],
    });
  });

  test.each([
    ['{ "__proto__": { "polluted": true } }', "__proto__"],
    ['{ "nested": { "__proto__": { "polluted": true } } }', "nested.__proto__"],
  ])("rejects unsafe JSONC keys before object materialization", (raw, key) => {
    expect(() => parseOpenCodeJsonc(raw, "test JSONC")).toThrow(key);
  });

  test.each([
    {
      name: "strict",
      content: `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`,
      security: { secretScan: "strict" as const, allowSecretValues: [] },
      rejected: true,
    },
    {
      name: "off",
      content: `ghp_${"a".repeat(36)}`,
      security: { secretScan: "off" as const, allowSecretValues: [] },
      rejected: false,
    },
    {
      name: "allow-list",
      content: `ghp_${"b".repeat(36)}`,
      security: {
        secretScan: "standard" as const,
        allowSecretValues: [`ghp_${"b".repeat(36)}`],
      },
      rejected: false,
    },
  ])("applies the $name secret policy to native skill sidecars", async (item) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "skills", "policy-skill", "SKILL.md"), skill("policy-skill"));
    await put(join(defaultRoot, "skills", "policy-skill", "notes.md"), item.content);
    const config = createTestAgentSyncConfig({
      security: {
        ...createTestAgentSyncConfig().security,
        secretScan: item.security.secretScan,
        allowSecretValues: [...item.security.allowSecretValues],
      },
    });

    const result = await snapshotOpenCode(config);
    expect(result.warnings.some((warning) => warning.startsWith("Detected literal secret"))).toBe(
      item.rejected,
    );
    expect(
      result.artifacts.some((artifact) => artifact.vaultPath.endsWith("policy-skill.tar.age")),
    ).toBe(!item.rejected);
  });

  test("scans the completed archive bytes instead of stale pre-archive reads", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const source = join(defaultRoot, "skills", "injected");
    await put(join(source, "SKILL.md"), skill("injected"));
    const injected = join(root, "injected-archive");
    await put(join(injected, "SKILL.md"), skill("injected"));
    await put(join(injected, "notes.md"), `ghp_${"q".repeat(36)}`);
    const injectedArchive = await archiveDirectory(injected);
    const archiveSpy = spyOn(tarModule, "archiveDirectory").mockResolvedValue(injectedArchive);

    try {
      const result = await snapshotOpenCode(createTestAgentSyncConfig());
      expect(result.artifacts).toHaveLength(0);
      expect(result.warnings.some((warning) => warning.includes("notes.md"))).toBe(true);
    } finally {
      archiveSpy.mockRestore();
    }
  });

  test("rejects a nested skill manifest introduced in the completed archive", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const source = join(defaultRoot, "skills", "outer");
    await put(join(source, "SKILL.md"), skill("outer"));
    const injected = join(root, "nested-skill-archive");
    await put(join(injected, "SKILL.md"), skill("outer"));
    await put(join(injected, "nested", "child", "SKILL.md"), skill("child"));
    const injectedArchive = await archiveDirectory(injected);
    const archiveSpy = spyOn(tarModule, "archiveDirectory").mockResolvedValue(injectedArchive);

    try {
      await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
        "no nested SKILL.md",
      );
    } finally {
      archiveSpy.mockRestore();
    }
  });

  test("rejects a hardlinked skill sidecar before it can enter the retained archive", async () => {
    if (process.platform === "win32") return;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const skillRoot = join(defaultRoot, "skills", "hardlinked");
    await put(join(skillRoot, "SKILL.md"), skill("hardlinked"));
    await put(join(skillRoot, "notes.md"), "notes\n");
    await link(join(skillRoot, "notes.md"), join(skillRoot, "copy.md"));

    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow();
  });

  test("ignores hidden native skill packages without dropping dotfile sidecars", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "skills", ".hidden", "SKILL.md"), skill(".hidden"));
    await put(join(defaultRoot, "skills", "group", ".hidden", "SKILL.md"), skill(".hidden"));
    await put(join(defaultRoot, "skills", "group", "visible", "SKILL.md"), skill("visible"));
    await put(join(defaultRoot, "skills", "group", "visible", ".env.example"), "SAFE=true\n");

    const result = await snapshotOpenCode(createTestAgentSyncConfig());
    expect(result.artifacts.map((artifact) => artifact.vaultPath)).toEqual([
      "opencode/default/skills/group/visible.tar.age",
    ]);
    const archive = Buffer.from(result.artifacts[0]?.plaintext ?? "", "base64");
    expect((await listArchiveEntries(archive)).map((entry) => entry.path)).toContain(
      ".env.example",
    );
  });

  test("blocks a selected unsafe OpenCode skill by its exact vault identity", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "skills", "unsafe", "SKILL.md"), skill("unsafe"));
    await put(join(defaultRoot, "skills", "unsafe", "auth.json"), '{"token":"x"}');
    const fixtureRoot = join(root, "selected-push");
    const bareRepoPath = await createBareRepo(fixtureRoot);
    const machine = await createMachineFixture(fixtureRoot, "selected-machine");
    seedVaultRepo({
      machine,
      bareRepoPath,
      agents: { claude: false, opencode: true },
    });
    const runtimeKeys = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"] as const;
    const saved = Object.fromEntries(runtimeKeys.map((key) => [key, process.env[key]]));
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
    const openCode = Agents.find((agent) => agent.name === "opencode");
    if (!openCode) throw new Error("OpenCode adapter is not registered");
    __setPushAgentsForTesting([openCode]);

    try {
      const vaultPath = "opencode/default/skills/unsafe.tar.age";
      const result = await performPush({ agent: "opencode", vaultPaths: new Set([vaultPath]) });
      expect(result.fatal).toBe(true);
      expect(result.pushed).toBe(0);
      expect(result.errors.some((error) => error.includes("auth.json"))).toBe(true);
      expect(result.errors.some((error) => error.includes(encodeURIComponent(vaultPath)))).toBe(
        true,
      );
    } finally {
      __setPushAgentsForTesting(null);
      for (const key of runtimeKeys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("rejects duplicate command and skill identities across roots before producing artifacts", async () => {
    process.env.OPENCODE_CONFIG_DIR = customRoot;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "command", "team", "review.md"), "one\n");
    await put(join(customRoot, "commands", "team", "review.md"), "two\n");
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "Duplicate OpenCode command identity",
    );
    await rm(join(customRoot, "commands"), { recursive: true });
    await put(join(defaultRoot, "skill", "first", "same", "SKILL.md"), skill("same"));
    await put(join(customRoot, "skills", "second", "same", "SKILL.md"), skill("same"));
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "Duplicate OpenCode skill identity",
    );
  });

  test("rejects malformed JSONC and symlinked discovery roots", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "opencode.jsonc"), '{ "broken": }');
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow(
      "valid JSONC object",
    );
    await rm(join(defaultRoot, "opencode.jsonc"));
    if (process.platform === "win32") return;
    const outside = join(root, "outside");
    await put(join(outside, "escaped.md"), "escaped\n");
    await mkdir(defaultRoot, { recursive: true });
    await symlink(outside, join(defaultRoot, "commands"));
    await expect(snapshotOpenCode(createTestAgentSyncConfig())).rejects.toThrow("real directory");
  });
});

describe("OpenCode explicit restore", () => {
  test.each([
    "OPENCODE_PERMISSION",
    "OPENCODE_TEST_HOME",
  ] as const)("preflight rejects active %s before restore", async (name) => {
    process.env[name] = name === "OPENCODE_PERMISSION" ? "{}" : join(root, "other-home");
    await expect(
      buildOpenCodePlan(createTestAgentSyncConfig()).preflight?.([
        "opencode/default/AGENTS.md.age",
      ]),
    ).rejects.toThrow(name);
  });

  test.each([
    "OPENCODE_TEST_HOME",
    "OPENCODE_CONFIG_DIR",
  ] as const)("preflight rejects exported-empty %s before restore", async (name) => {
    process.env[name] = "";
    await expect(
      buildOpenCodePlan(createTestAgentSyncConfig()).preflight?.([
        "opencode/default/AGENTS.md.age",
      ]),
    ).rejects.toThrow(name);
  });

  test("preflight rejects an active fixed-home OpenCode source before restore", async () => {
    await put(join(root, ".opencode", "commands", "local.md"), "# Local\n");

    await expect(
      buildOpenCodePlan(createTestAgentSyncConfig()).preflight?.([
        "opencode/default/AGENTS.md.age",
      ]),
    ).rejects.toThrow("OpenCode home command");
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  test("additively patches JSONC while preserving local comments, fields, and real secrets", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(
      join(defaultRoot, "opencode.jsonc"),
      '{\n  // local comment\n  "localOnly": true,\n  "apiKey": "sk-local-real-value",\n  "shared": "old"\n}\n',
    );
    const incoming = `{
  // vault comment
  "apiKey": "$AGENTSYNC_REDACTED_APIKEY",
  "shared": "new",
  "path": "${AGENTSYNC_HOME_PLACEHOLDER}/bin"
}\n`;
    const { identity, recipient } = await createAgeIdentity();
    const machineRoot = join(root, "machine");
    const vaultPath = "opencode/default/opencode.jsonc.age";
    await put(join(machineRoot, vaultPath), await encryptString(incoming, [recipient]));

    await applySingleArtifact(
      buildOpenCodePlan(createTestAgentSyncConfig()),
      vaultPath,
      machineRoot,
      identity,
      false,
    );

    const restored = await readFile(join(defaultRoot, "opencode.jsonc"), "utf8");
    expect(restored).toContain("// local comment");
    expect(restored).toContain('"localOnly": true');
    expect(restored).toContain('"apiKey": "sk-local-real-value"');
    expect(restored).toContain('"shared": "new"');
    expect(restored).toContain(`${homedir()}/bin`);
  });

  test("restores recursive Markdown and skill sidecar paths", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const machineRoot = join(root, "machine");
    const commandPath = "opencode/default/commands/team/review.md.age";
    await put(join(machineRoot, commandPath), await encryptString("# Review\n", [recipient]));

    const sourceSkill = join(root, "source-skill");
    await put(join(sourceSkill, "SKILL.md"), skill("helper"));
    await put(join(sourceSkill, "scripts", "run.sh"), "#!/bin/sh\n");
    const archive = await archiveDirectory(sourceSkill, { skipSymlinks: true });
    const skillPath = "opencode/default/skills/team/helper.tar.age";
    await put(
      join(machineRoot, skillPath),
      await encryptString(archive.toString("base64"), [recipient]),
    );

    const plan = buildOpenCodePlan(createTestAgentSyncConfig());
    await plan.preflight?.([commandPath, skillPath]);
    await applySingleArtifact(plan, commandPath, machineRoot, identity, false);
    await applySingleArtifact(plan, skillPath, machineRoot, identity, false);

    expect(await readFile(join(defaultRoot, "commands", "team", "review.md"), "utf8")).toBe(
      "# Review\n",
    );
    expect(await readFile(join(defaultRoot, "skills", "team", "helper", "SKILL.md"), "utf8")).toBe(
      skill("helper"),
    );
    expect(
      await readFile(join(defaultRoot, "skills", "team", "helper", "scripts", "run.sh"), "utf8"),
    ).toBe("#!/bin/sh\n");
  });

  test.each([
    {
      name: "never-sync auth.json",
      file: "auth.json",
      content: '{"token":"x"}',
      security: {},
      message: "never-sync inside skill",
    },
    {
      name: "strict policy secret",
      file: "notes.md",
      content: `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`,
      security: { secretScan: "strict" as const },
      message: "Detected literal secret",
    },
    {
      name: "catastrophic secret with scanning off",
      file: "key.txt",
      content: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`,
      security: { secretScan: "off" as const },
      message: "Detected literal secret",
    },
  ])("rejects $name before any restore write", async (item) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, `unsafe-restore-${item.file.replace(".", "-")}`);
    await put(
      join(vaultDir, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier\n", [recipient]),
    );
    const sourceSkill = join(root, `unsafe-source-${item.file.replace(".", "-")}`);
    await put(join(sourceSkill, "SKILL.md"), skill("unsafe"));
    await put(join(sourceSkill, item.file), item.content);
    const archive = await archiveDirectory(sourceSkill);
    await put(
      join(vaultDir, "opencode", "default", "skills", "unsafe.tar.age"),
      await encryptString(archive.toString("base64"), [recipient]),
    );
    const config = createTestAgentSyncConfig({
      security: {
        ...createTestAgentSyncConfig().security,
        ...item.security,
      },
    });

    await expect(
      runApplyPlan(buildOpenCodePlan(config), vaultDir, identity, false),
    ).rejects.toThrow(item.message);
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(defaultRoot, "skills", "unsafe", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("enforces the production skill archive size limit before any restore write", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, "oversized-restore");
    await put(
      join(vaultDir, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier\n", [recipient]),
    );
    const sourceSkill = join(root, "oversized-source");
    await put(join(sourceSkill, "SKILL.md"), skill("oversized"));
    await writeFile(join(sourceSkill, "large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1, "A"));
    const archive = await archiveDirectory(sourceSkill);
    await put(
      join(vaultDir, "opencode", "default", "skills", "oversized.tar.age"),
      await encryptString(archive.toString("base64"), [recipient]),
    );

    await expect(
      runApplyPlan(buildOpenCodePlan(createTestAgentSyncConfig()), vaultDir, identity, false),
    ).rejects.toThrow("8388608-byte limit");
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(defaultRoot, "skills", "oversized", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test.each([
    {
      name: "missing root SKILL.md",
      skillName: "missing",
      content: null,
      message: "must retain exactly one SKILL.md",
    },
    {
      name: "mismatched root SKILL.md name",
      skillName: "expected",
      content: skill("other"),
      message: "must declare name 'expected'",
    },
  ])("rejects a skill archive with $name before any restore write", async (item) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, `invalid-contract-${item.skillName}`);
    await put(
      join(vaultDir, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier\n", [recipient]),
    );
    const sourceSkill = join(root, `invalid-contract-source-${item.skillName}`);
    if (item.content === null) await put(join(sourceSkill, "README.md"), "No contract\n");
    else await put(join(sourceSkill, "SKILL.md"), item.content);
    const archive = await archiveDirectory(sourceSkill);
    await put(
      join(vaultDir, "opencode", "default", "skills", `${item.skillName}.tar.age`),
      await encryptString(archive.toString("base64"), [recipient]),
    );

    await expect(
      runApplyPlan(buildOpenCodePlan(createTestAgentSyncConfig()), vaultDir, identity, false),
    ).rejects.toThrow(item.message);
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(defaultRoot, "skills", item.skillName, "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("rejects a nested skill manifest before any restore write", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, "nested-manifest-restore");
    await put(
      join(vaultDir, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier\n", [recipient]),
    );
    const sourceSkill = join(root, "nested-manifest-source");
    await put(join(sourceSkill, "SKILL.md"), skill("outer"));
    await put(join(sourceSkill, "nested", "child", "SKILL.md"), skill("child"));
    const archive = await archiveDirectory(sourceSkill);
    await put(
      join(vaultDir, "opencode", "default", "skills", "outer.tar.age"),
      await encryptString(archive.toString("base64"), [recipient]),
    );

    await expect(
      runApplyPlan(buildOpenCodePlan(createTestAgentSyncConfig()), vaultDir, identity, false),
    ).rejects.toThrow("no nested SKILL.md");
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(defaultRoot, "skills", "outer", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(defaultRoot, "skills", "outer", "nested", "child", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test.each([
    {
      name: "off",
      content: `ghp_${"o".repeat(36)}`,
      security: { secretScan: "off" as const },
    },
    {
      name: "allow-list",
      content: `ghp_${"l".repeat(36)}`,
      security: { allowSecretValues: [`ghp_${"l".repeat(36)}`] as string[] },
    },
  ])("restores an ordinary secret under the $name policy", async (item) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, `allowed-restore-${item.name}`);
    const sourceSkill = join(root, `allowed-source-${item.name}`);
    await put(join(sourceSkill, "SKILL.md"), skill("allowed"));
    await put(join(sourceSkill, "notes.md"), item.content);
    const archive = await archiveDirectory(sourceSkill);
    await put(
      join(vaultDir, "opencode", "default", "skills", "allowed.tar.age"),
      await encryptString(archive.toString("base64"), [recipient]),
    );
    const config = createTestAgentSyncConfig({
      security: {
        ...createTestAgentSyncConfig().security,
        ...item.security,
      },
    });

    await runApplyPlan(buildOpenCodePlan(config), vaultDir, identity, false);
    expect(await readFile(join(defaultRoot, "skills", "allowed", "notes.md"), "utf8")).toBe(
      item.content,
    );
  });

  test("preflights the complete batch before writing any colliding identity", async () => {
    process.env.OPENCODE_CONFIG_DIR = customRoot;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, "vault");
    await put(
      join(vaultDir, "opencode", "default", "command", "same.md.age"),
      await encryptString("default\n", [recipient]),
    );
    await put(
      join(vaultDir, "opencode", "custom", "commands", "same.md.age"),
      await encryptString("custom\n", [recipient]),
    );

    await expect(
      runApplyPlan(buildOpenCodePlan(createTestAgentSyncConfig()), vaultDir, identity, false),
    ).rejects.toThrow("Duplicate OpenCode command identity");
    await expect(readFile(join(defaultRoot, "command", "same.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(customRoot, "commands", "same.md"), "utf8")).rejects.toThrow();
  });

  test("rejects a file and descendant target before any restore write", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const vaultDir = join(root, "file-descendant-restore");
    await put(join(vaultDir, "opencode", "default", "AGENTS.md.age"), "not ciphertext");
    await put(join(vaultDir, "opencode", "default", "commands", "foo.md.age"), "first");
    await put(join(vaultDir, "opencode", "default", "commands", "foo.md", "bar.md.age"), "second");

    await expect(
      runApplyPlan(buildOpenCodePlan(createTestAgentSyncConfig()), vaultDir, "unused", false),
    ).rejects.toThrow("file/directory collision");
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(defaultRoot, "commands", "foo.md"), "utf8")).rejects.toThrow();
  });

  test("requires the matching custom origin and keeps dry-run write-free", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const plan = buildOpenCodePlan(createTestAgentSyncConfig());
    await expect(plan.preflight?.(["opencode/custom/AGENTS.md.age"])).rejects.toThrow(
      "requires OPENCODE_CONFIG_DIR",
    );

    const { identity, recipient } = await createAgeIdentity();
    const machineRoot = join(root, "machine");
    const path = "opencode/default/AGENTS.md.age";
    await put(join(machineRoot, path), await encryptString("rules\n", [recipient]));
    await applySingleArtifact(plan, path, machineRoot, identity, true);
    await expect(readFile(join(defaultRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  test("rejects traversal before decryption or target writes", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await expect(
      applySingleArtifact(
        buildOpenCodePlan(createTestAgentSyncConfig()),
        "opencode/default/command/../../escaped.md.age",
        root,
        "not-a-key",
        false,
      ),
    ).rejects.toThrow("reserved path segment");
    await expect(readFile(join(root, "escaped.md"), "utf8")).rejects.toThrow();
  });

  test("rejects a symlinked target file without mutating its target", async () => {
    if (process.platform === "win32") return;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const outside = join(root, "outside-target.md");
    await put(outside, "outside unchanged\n");
    await mkdir(defaultRoot, { recursive: true });
    await symlink(outside, join(defaultRoot, "AGENTS.md"));
    const { identity, recipient } = await createAgeIdentity();
    const machineRoot = join(root, "machine-target-link");
    const vaultPath = "opencode/default/AGENTS.md.age";
    await put(join(machineRoot, vaultPath), await encryptString("incoming\n", [recipient]));

    await expect(
      applySingleArtifact(
        buildOpenCodePlan(createTestAgentSyncConfig()),
        vaultPath,
        machineRoot,
        identity,
        false,
      ),
    ).rejects.toThrow("regular file");
    expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");
  });

  test("rejects a symlinked target ancestor without mutating the external directory", async () => {
    if (process.platform === "win32") return;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const outside = join(root, "outside-root");
    await mkdir(outside, { recursive: true });
    await symlink(outside, defaultRoot);
    const { identity, recipient } = await createAgeIdentity();
    const machineRoot = join(root, "machine-ancestor-link");
    const vaultPath = "opencode/default/AGENTS.md.age";
    await put(join(machineRoot, vaultPath), await encryptString("incoming\n", [recipient]));

    await expect(
      applySingleArtifact(
        buildOpenCodePlan(createTestAgentSyncConfig()),
        vaultPath,
        machineRoot,
        identity,
        false,
      ),
    ).rejects.toThrow("real directory");
    await expect(readFile(join(outside, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  test("rejects a link inside an existing skill target without mutating it", async () => {
    if (process.platform === "win32") return;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    const outside = join(root, "outside-skill-sidecar.md");
    await put(outside, "outside unchanged\n");
    const target = join(defaultRoot, "skills", "helper");
    await put(join(target, "SKILL.md"), skill("helper"));
    await symlink(outside, join(target, "linked.md"));
    const sourceSkill = join(root, "source-linked-target-skill");
    await put(join(sourceSkill, "SKILL.md"), skill("helper"));
    await put(join(sourceSkill, "new.md"), "new\n");
    const archive = await archiveDirectory(sourceSkill, { skipSymlinks: true });
    const { identity, recipient } = await createAgeIdentity();
    const machineRoot = join(root, "machine-skill-link");
    const vaultPath = "opencode/default/skills/helper.tar.age";
    await put(
      join(machineRoot, vaultPath),
      await encryptString(archive.toString("base64"), [recipient]),
    );

    await expect(
      applySingleArtifact(
        buildOpenCodePlan(createTestAgentSyncConfig()),
        vaultPath,
        machineRoot,
        identity,
        false,
      ),
    ).rejects.toThrow("must not be a symbolic link");
    expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");
    await expect(readFile(join(target, "new.md"), "utf8")).rejects.toThrow();
  });
});

describe("OpenCode status", () => {
  test("compares the same deterministic artifact plaintext used by push", async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "AGENTS.md"), "global rules\n");
    const config = createTestAgentSyncConfig({
      agents: {
        claude: false,
        cursor: false,
        codex: false,
        copilot: false,
        vscode: false,
        opencode: true,
      },
    });
    const artifact = (await snapshotOpenCode(config)).artifacts[0];
    if (!artifact) throw new Error("Expected an OpenCode snapshot artifact");
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, "status-vault");
    const machineName = "status-machine";
    await put(
      join(machineVaultRoot(vaultDir, machineName), artifact.vaultPath),
      await encryptString(artifact.plaintext, [recipient]),
    );
    const openCode = Agents.find((agent) => agent.name === "opencode");
    if (!openCode) throw new Error("OpenCode adapter is not registered");

    const rows = await computeSyncStatus(
      {
        vaultDir,
        machineName,
        privateKeyPath: join(root, "unused-key"),
        machineFilePath: join(root, "unused-machine"),
      },
      config,
      identity,
      { agentsOverride: [openCode] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.vaultPath).toBe("opencode/default/AGENTS.md.age");
    expect(rows[0]?.status).toBe("synced");
  });

  test.each([
    ["never-sync", "auth.json", '{"token":"x"}'],
    ["literal secret", "notes.md", `sk-ant-api03-${"A".repeat(48)}`],
  ])("reports a single error and suppresses normal rows for a %s skill warning", async (_name, file, content) => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    await put(join(defaultRoot, "AGENTS.md"), "normal artifact\n");
    await put(join(defaultRoot, "skills", "blocked", "SKILL.md"), skill("blocked"));
    await put(join(defaultRoot, "skills", "blocked", file), content);
    const config = createTestAgentSyncConfig({
      agents: {
        claude: false,
        cursor: false,
        codex: false,
        copilot: false,
        vscode: false,
        opencode: true,
      },
    });
    const openCode = Agents.find((agent) => agent.name === "opencode");
    if (!openCode) throw new Error("OpenCode adapter is not registered");

    const rows = await computeSyncStatus(
      {
        vaultDir: join(root, "blocked-status-vault"),
        machineName: "status-machine",
        privateKeyPath: join(root, "unused-key"),
        machineFilePath: join(root, "unused-machine"),
      },
      config,
      null,
      { agentsOverride: [openCode] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.displayName).toBe("(snapshot blocked)");
    expect(rows[0]?.detail).toContain(file);
  });

  test.each([
    ["artifact warning", "clean\n", ["Detected literal secret for field token"]],
    ["plaintext secret", `ghp_${"z".repeat(36)}`, []],
  ])("blocks normal rows for a snapshot %s", async (_name, plaintext, artifactWarnings) => {
    const config = createTestAgentSyncConfig({
      agents: {
        claude: false,
        cursor: false,
        codex: false,
        copilot: false,
        vscode: false,
        opencode: true,
      },
    });
    const agent: AgentDefinition = {
      name: "opencode",
      snapshot: async () => ({
        artifacts: [
          {
            vaultPath: "opencode/default/AGENTS.md.age",
            sourcePath: join(root, "AGENTS.md"),
            plaintext,
            warnings: artifactWarnings,
          },
        ],
        warnings: [],
      }),
      apply: async () => {},
      buildPlan: () => ({ agent: "opencode", directives: [] }),
    };

    const rows = await computeSyncStatus(
      {
        vaultDir: join(root, "safety-status-vault"),
        machineName: "status-machine",
        privateKeyPath: join(root, "unused-key"),
        machineFilePath: join(root, "unused-machine"),
      },
      config,
      null,
      { agentsOverride: [agent] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.displayName).toBe("(snapshot blocked)");
    expect(rows[0]?.detail).toContain("Detected literal secret");
  });

  test("does not surface existing vault files after snapshot throws", async () => {
    const config = createTestAgentSyncConfig({
      agents: {
        claude: false,
        cursor: false,
        codex: false,
        copilot: false,
        vscode: false,
        opencode: true,
      },
    });
    const agent: AgentDefinition = {
      name: "opencode",
      snapshot: async () => {
        throw new Error("snapshot exploded");
      },
      apply: async () => {},
      buildPlan: () => ({ agent: "opencode", directives: [] }),
    };
    const { identity, recipient } = await createAgeIdentity();
    const vaultDir = join(root, "failed-status-vault");
    const machineName = "status-machine";
    await put(
      join(machineVaultRoot(vaultDir, machineName), "opencode", "default", "AGENTS.md.age"),
      await encryptString("old vault artifact\n", [recipient]),
    );

    const rows = await computeSyncStatus(
      {
        vaultDir,
        machineName,
        privateKeyPath: join(root, "unused-key"),
        machineFilePath: join(root, "unused-machine"),
      },
      config,
      identity,
      { agentsOverride: [agent] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.displayName).toBe("(snapshot failed)");
    expect(rows[0]?.detail).toBe("snapshot exploded");
  });
});
