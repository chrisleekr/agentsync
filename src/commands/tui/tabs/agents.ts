import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { AgentPaths } from "../../../config/paths";
import type { AgentName, AgentNode, AppState } from "../state";
import type { Store } from "../store";

/**
 * What each agent presents to the Agents tab. Most are directory roots that
 * the walker recurses; vscode is a single owned file because the rest of the
 * `Code/User/` tree is editor state we have no business surfacing.
 */
type AgentSurface = { kind: "dir"; path: string } | { kind: "single-file"; path: string };

function surfaceForAgent(agent: AgentName): AgentSurface {
  switch (agent) {
    case "claude":
      return { kind: "dir", path: dirname(AgentPaths.claude.claudeMd) };
    case "cursor":
      return { kind: "dir", path: dirname(AgentPaths.cursor.mcpGlobal) };
    case "codex":
      return { kind: "dir", path: AgentPaths.codex.root };
    case "copilot":
      return { kind: "dir", path: dirname(AgentPaths.copilot.instructionsFile) };
    case "vscode":
      // AgentSync only owns mcp.json under the VS Code user profile. The
      // surrounding tree is editor state; recursing into it would surface
      // unrelated files in this tab.
      return { kind: "single-file", path: AgentPaths.vscode.mcpJson };
  }
}

async function walk(base: string): Promise<AgentNode["files"]> {
  const out: AgentNode["files"] = [];
  async function rec(dir: string, prefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      const rel = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) {
        await rec(full, rel);
      } else if (info.isFile()) {
        out.push({ rel, size: info.size, mtime: info.mtimeMs });
      }
    }
  }
  await rec(base, "");
  return out;
}

async function loadAgents(): Promise<AgentNode[]> {
  const order: AgentName[] = ["claude", "cursor", "codex", "copilot", "vscode"];
  const nodes: AgentNode[] = [];
  for (const agent of order) {
    const surface = surfaceForAgent(agent);
    if (surface.kind === "single-file") {
      const info = await stat(surface.path).catch(() => null);
      const installed = info?.isFile() === true;
      const files = installed
        ? [{ rel: basename(surface.path), size: info.size, mtime: info.mtimeMs }]
        : [];
      nodes.push({ agent, baseDir: surface.path, installed, files });
      continue;
    }
    let installed = false;
    try {
      const info = await stat(surface.path);
      installed = info.isDirectory();
    } catch {
      installed = false;
    }
    const files = installed ? await walk(surface.path) : [];
    nodes.push({ agent, baseDir: surface.path, installed, files });
  }
  return nodes;
}

export function renderAgents(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const a = state.agents;
  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: "#11151a",
  });
  host.add(wrapper);

  const box = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Local agent content ",
    backgroundColor: "#11151a",
  });
  wrapper.add(box);

  if (a.phase !== "ready" || a.nodes.length === 0) {
    box.add(
      new TextRenderable(renderer, {
        content: "\n  Loading agent installs…",
        fg: "#6c7886",
        bg: "#11151a",
      }),
    );
    return;
  }

  const rows: string[] = [];
  for (const node of a.nodes) {
    if (!node.installed) {
      rows.push(`  ○ ${node.agent.padEnd(8)} (${node.baseDir}) — not installed`);
      continue;
    }
    rows.push(`  ● ${node.agent.padEnd(8)} (${node.baseDir})  ${node.files.length} file(s)`);
    const shown = node.files.slice(0, 5);
    for (const f of shown) {
      const size = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}K`;
      rows.push(`      ${f.rel.padEnd(50)} ${size}`);
    }
    if (node.files.length > shown.length) {
      rows.push(`      … ${node.files.length - shown.length} more`);
    }
  }
  box.add(
    new TextRenderable(renderer, {
      content: rows.join("\n"),
      fg: "#d8dee9",
      bg: "#11151a",
    }),
  );
}

export function ensureAgentsLoaded(store: Store): void {
  const a = store.getState().agents;
  if (a.phase === "loading" || a.phase === "ready") return;
  store.dispatch((d) => {
    d.agents.phase = "loading";
  });
  store.runOperation("agents-load", "load agent installs", () => loadAgents(), {
    onSuccess: (draft, nodes) => {
      draft.agents.nodes = nodes as AgentNode[];
      draft.agents.phase = "ready";
    },
    onError: (draft, err) => {
      draft.agents.nodes = [];
      draft.agents.phase = "error";
      draft.agents.error = err.message;
    },
  });
}

export function onAgentsKey(_key: KeyEvent, _store: Store): boolean {
  return false;
}
