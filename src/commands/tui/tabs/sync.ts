import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { Agents } from "../../../agents/registry";
import { decryptString } from "../../../core/encryptor";
import { listArchiveEntries } from "../../../core/tar";
import { pairDiffRows, type SideBySideRow } from "../../../lib/diff";
import { performPull } from "../../pull";
import { performPush } from "../../push";
import { loadPrivateKey, loadVaultConfigOrExit, resolveRuntimeContext } from "../../shared";
import { computeSyncStatus, type SyncRow } from "../../status";
import type { AppState, DiffModalState, SkillDrillInState, SkillFile } from "../state";
import { setToast } from "../state";
import type { Store } from "../store";
import { runBulkSkillRemove } from "./_skill-remove";

const PALETTE: Record<
  "panelBg" | "border" | "text" | "textDim" | "good" | "warn" | "bad" | "cyan" | "accent" | "hl",
  string
> = {
  panelBg: "#11151a",
  border: "#3b4252",
  text: "#d8dee9",
  textDim: "#6c7886",
  good: "#a3be8c",
  warn: "#ebcb8b",
  bad: "#bf616a",
  cyan: "#88c0d0",
  accent: "#88c0d0",
  hl: "#3b4252",
};

const SIDE_BY_SIDE_MIN_WIDTH = 120;

/** Approximate rows moved by PageUp/PageDown. Picked to be slightly less than
 *  a typical viewport so context survives across page jumps. */
const PAGE_STEP = 15;

/** Estimated chrome (title bar, tab bar, banner, action bar, footer, borders)
 *  subtracted from `terminalHeight` to derive the listBox viewport. */
const CHROME_HEIGHT_RESERVE = 10;

/**
 * Write `text` to the terminal clipboard via OSC 52. No subprocess, no
 * platform detection — works in iTerm2, kitty, alacritty, wezterm, Terminal.app
 * (recent), and Windows Terminal. Some terminals require enabling clipboard
 * write explicitly; in that case the write is a no-op (still safe).
 */
function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
}

const STATUS_VERB: Record<SyncRow["status"], string> = {
  synced: "synced",
  "local-changed": "modified",
  "local-only": "new",
  "vault-only": "missing",
  unknown: "unknown",
  error: "error",
};

/** Ordered list of sections to render. Synced is last and is the only one
 *  that can be collapsed; the rest are always expanded so drift is visible. */
type Section = {
  key: SyncRow["status"];
  title: string;
  hint: string;
};

const SECTIONS: Section[] = [
  {
    key: "error",
    title: "Errors",
    hint: "investigate before pushing",
  },
  {
    key: "local-changed",
    title: "To push: local edits",
    hint: "press p",
  },
  {
    key: "local-only",
    title: "To push: local additions",
    hint: "press p",
  },
  {
    key: "vault-only",
    title: "To pull: vault-only, not in local",
    hint: "press l",
  },
  {
    key: "unknown",
    title: "Status unknown (no decryption key)",
    hint: "press k to load key",
  },
  {
    key: "synced",
    title: "Synced",
    hint: "press s to expand",
  },
];

function stripAge(p: string): string {
  return p.replace(/\.tar\.age$/, "").replace(/\.age$/, "");
}

function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length <= width) return s.padEnd(width);
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

/** Group rows by status. Within each group, sort by vaultPath for stable order. */
function groupByStatus(rows: SyncRow[]): Map<SyncRow["status"], SyncRow[]> {
  const m = new Map<SyncRow["status"], SyncRow[]>();
  for (const r of rows) {
    const list = m.get(r.status) ?? [];
    list.push(r);
    m.set(r.status, list);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
  }
  return m;
}

/**
 * The flat list of rows the cursor can land on, in render order. Synced
 * rows only appear when expanded. Cursor operations index INTO this list,
 * so it's the source of truth for navigation.
 */
function navigableRows(state: AppState): SyncRow[] {
  const groups = groupByStatus(state.sync.rows);
  const out: SyncRow[] = [];
  for (const section of SECTIONS) {
    if (section.key === "synced" && !state.sync.showSynced) continue;
    const rows = groups.get(section.key) ?? [];
    out.push(...rows);
  }
  return out;
}

async function loadRows(privateKey: string | null): Promise<SyncRow[]> {
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  return computeSyncStatus(runtime, config, privateKey);
}

export function ensureSyncLoaded(store: Store): void {
  const s = store.getState().sync;
  if (s.phase === "loading" || s.phase === "ready") return;

  store.dispatch((d) => {
    d.sync.phase = "loading";
    d.sync.error = null;
    if (d.sync.keyPrompt === "idle" && !d.sync.keyLoaded) {
      d.sync.keyPrompt = "pending";
    }
  });

  const key = store.getState().sync.keyCache;
  store.runOperation("sync-load", "load sync rows", () => loadRows(key), {
    onSuccess: (draft, rows) => {
      const list = rows as SyncRow[];
      draft.sync.rows = list;
      draft.sync.cursor = 0;
      draft.sync.phase = "ready";
      draft.sync.error = null;
    },
    onError: (draft, err) => {
      draft.sync.phase = "error";
      draft.sync.error = err.message;
    },
  });
}

function runKeyLoad(store: Store): void {
  void resolveRuntimeContext().then(async (runtime) => {
    try {
      const key = await loadPrivateKey(runtime.privateKeyPath);
      store.dispatch((d) => {
        d.sync.keyCache = key;
        d.sync.keyLoaded = true;
        d.sync.keyPrompt = "idle";
        d.sync.phase = "idle";
      });
      ensureSyncLoaded(store);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.dispatch((d) => {
        d.sync.keyPrompt = "skipped";
        setToast(d, `Key load failed: ${message}`, "error");
      });
    }
  });
}

/**
 * Run a push or pull from the Sync tab. Always writes a persistent
 * `lastOp` result so the user can see what happened — even after the
 * toast fades. The global `p`/`l` keymap in app.ts delegates here so all
 * push/pull invocations go through the same plumbing.
 */
export function runSyncOp(store: Store, op: "push" | "pull"): void {
  if (!store.getState().sync.keyCache) {
    store.dispatch((d) => {
      setToast(d, "Load private key first (press k)", "error");
      d.sync.lastOp = {
        kind: op,
        status: "error",
        message: "private key not loaded — press k to load",
        ts: Date.now(),
      };
    });
    return;
  }
  // Push from the TUI requires an explicit selection. A bulk push of every
  // pending change is still available via the CLI (`agentsync push`) where
  // it runs under the stricter full-scan secret-detection gate. Refusing
  // empty-selection here removes the ambiguity between TUI and CLI modes,
  // and prevents an accidental key-press from publishing every drift row.
  const selection = store.getState().selection;
  if (op === "push" && selection.size === 0) {
    store.dispatch((d) => {
      setToast(d, "Select files to push (press space on rows)", "error");
      d.sync.lastOp = {
        kind: "push",
        status: "error",
        message: "nothing selected — press space to mark files, then p to push",
        ts: Date.now(),
      };
    });
    return;
  }
  // Selection has no effect on pull (pull is by-agent, not by-file).
  const selectedVaultPaths = op === "push" ? new Set(selection) : undefined;

  const runningMessage = selectedVaultPaths
    ? `${op}ing ${selectedVaultPaths.size} selected file(s)…`
    : `${op}…`;
  store.dispatch((d) => {
    d.sync.lastOp = { kind: op, status: "running", message: runningMessage, ts: Date.now() };
  });
  store.runOperation(
    op,
    `${op} vault`,
    async () => (op === "push" ? performPush({ vaultPaths: selectedVaultPaths }) : performPull()),
    {
      activityKind: op,
      onSuccess: (draft, result) => {
        if (op === "push") {
          const r = result as Awaited<ReturnType<typeof performPush>>;
          if (r.fatal) {
            // performPush returns a flat string[] where the first entry is
            // the summary ("Push aborted: N security issue(s) detected …")
            // and the rest are per-issue details. Split that here so the
            // banner can render the summary inline and indent each detail
            // beneath it — no truncation, no losing file paths.
            const [summary = "push failed", ...details] = r.errors;
            setToast(draft, `Push failed: ${summary}`, "error");
            draft.sync.lastOp = {
              kind: "push",
              status: "error",
              message: summary,
              details: details.length > 0 ? details : undefined,
              ts: Date.now(),
            };
          } else {
            const msg = `pushed ${r.pushed} artifact(s)`;
            setToast(draft, `Push ok: ${r.pushed} artifact(s)`, "success");
            draft.sync.lastOp = { kind: "push", status: "ok", message: msg, ts: Date.now() };
            draft.sync.phase = "idle";
            // Drop only the paths that were actually pushed in this op,
            // not the whole selection set. The push captured its paths via
            // `new Set(selection)` at launch, so any rows the user space-
            // toggled while the push was async are intentionally outside
            // this op's scope and must survive into the next push.
            if (selectedVaultPaths) {
              for (const p of selectedVaultPaths) draft.selection.delete(p);
            }
          }
        } else {
          const r = result as Awaited<ReturnType<typeof performPull>>;
          if (r.fatal) {
            const [summary = "pull failed", ...details] = r.errors;
            setToast(draft, `Pull failed: ${summary}`, "error");
            draft.sync.lastOp = {
              kind: "pull",
              status: "error",
              message: summary,
              details: details.length > 0 ? details : undefined,
              ts: Date.now(),
            };
          } else {
            const msg = `applied ${r.applied} agent(s)`;
            setToast(draft, `Pull ok: ${r.applied} agent(s) applied`, "success");
            draft.sync.lastOp = { kind: "pull", status: "ok", message: msg, ts: Date.now() };
            draft.sync.phase = "idle";
          }
        }
      },
      onError: (draft, err) => {
        draft.sync.lastOp = {
          kind: op,
          status: "error",
          message: err.message,
          ts: Date.now(),
        };
      },
      errorToastPrefix: op,
    },
  );
}

/** Decrypt the vault entry + re-snapshot the local artifact for `row`,
 *  returning the two plaintexts. Errors return strings prefixed with `(` so
 *  callers can detect failure and surface the message verbatim. */
async function loadDiffPlaintexts(
  row: SyncRow,
  privateKey: string,
): Promise<{ vaultPlain: string; localPlain: string } | { error: string }> {
  if (!row.sourcePath) return { error: "(vault-only — no local file to compare against)" };
  const agent = Agents.find((a) => a.name === row.agent);
  if (!agent) return { error: `(unknown agent: ${row.agent})` };
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  const snapshot = await agent.snapshot(config);
  const artifact = snapshot.artifacts.find((a) => a.vaultPath === row.vaultPath);
  if (!artifact) return { error: "(local artifact not found in current snapshot)" };

  try {
    const encrypted = await readFile(row.vaultAbsPath, "utf8");
    const vaultPlain = await decryptString(encrypted, privateKey);
    return { vaultPlain, localPlain: artifact.plaintext };
  } catch (err) {
    return {
      error: `(failed to decrypt vault file: ${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

function openDiff(store: Store): void {
  const visible = navigableRows(store.getState());
  const row = visible[store.getState().sync.cursor];
  if (!row) return;

  if (row.isSkill) {
    openSkillDrillIn(store, row);
    return;
  }
  if (row.status === "synced") {
    store.dispatch((d) => setToast(d, "No diff — status is synced", "info"));
    return;
  }
  if (row.status === "local-only" || row.status === "vault-only") {
    store.dispatch((d) => setToast(d, `No diff — status is ${row.status}`, "info"));
    return;
  }
  const key = store.getState().sync.keyCache;
  if (!key) {
    store.dispatch((d) => setToast(d, "Load private key first (press k)", "error"));
    return;
  }
  void loadDiffPlaintexts(row, key).then((result) => {
    if ("error" in result) {
      store.dispatch((d) => setToast(d, result.error, "error"));
      return;
    }
    store.dispatch((d) => {
      d.sync.diff = {
        vaultPath: row.vaultPath,
        vaultPlain: result.vaultPlain,
        localPlain: result.localPlain,
        cursor: 0,
        side: "local",
        selectedVault: new Set<number>(),
        selectedLocal: new Set<number>(),
        scrollOffset: 0,
      };
    });
  });
}

/**
 * Walk a skill directory into in-memory entries, mirroring the security
 * posture of `archiveDirectory({ skipSymlinks: true })`: symlinks are
 * dropped, dotfiles included, traversal impossible because we always
 * relative-to the skill root.
 */
async function walkSkillDir(dir: string): Promise<{ path: string; content: Buffer }[]> {
  const out: { path: string; content: Buffer }[] = [];
  async function recurse(current: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await recurse(full);
      } else if (stat.isFile()) {
        const buf = await readFile(full);
        const content = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        const rel = relative(dir, full).replaceAll("\\", "/");
        out.push({ path: rel, content });
      }
    }
  }
  await recurse(dir);
  return out;
}

/**
 * Best-effort UTF-8 decode. Returns `{ text, isBinary }` where `isBinary`
 * is true if the buffer contains NUL bytes (the standard heuristic used
 * by git for "binary or not"). Binary files are not usefully diffable
 * line-by-line, so the drill-in renders them as `(binary — N bytes)`.
 */
function tryDecodeText(buf: Buffer): { text: string; isBinary: boolean } {
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    if (buf[i] === 0) return { text: "", isBinary: true };
  }
  return { text: buf.toString("utf8"), isBinary: false };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Decrypt the skill's `.tar.age`, parse entries in memory, walk the local
 * skill dir, pair up files by relative path, compute per-file sync status.
 * Dispatches the resulting drill-in panel onto `sync.skillDrillIn`.
 *
 * Decrypted plaintext lives only inside the dispatched state object — it
 * is dropped the moment the user closes the drill-in (esc clears the slot).
 */
/**
 * Ordering used for both the drill-in cursor sequence AND the renderer's
 * section sweep. Keeping them in lockstep means pressing ↓ on the drill-in
 * file list always lands on the row visually below the cursor — alphabetic
 * sort on its own would skip across status groups and surprise the user.
 */
const SKILL_FILE_SECTION_ORDER: SkillFile["status"][] = [
  "local-changed",
  "local-only",
  "vault-only",
  "synced",
];

function sortSkillFiles(files: SkillFile[]): SkillFile[] {
  return [...files].sort((a, b) => {
    const sa = SKILL_FILE_SECTION_ORDER.indexOf(a.status);
    const sb = SKILL_FILE_SECTION_ORDER.indexOf(b.status);
    if (sa !== sb) return sa - sb;
    return a.relPath.localeCompare(b.relPath);
  });
}

function openSkillDrillIn(store: Store, row: SyncRow): void {
  const key = store.getState().sync.keyCache;
  const needsKey = row.status !== "local-only";
  if (needsKey && !key) {
    store.dispatch((d) => setToast(d, "Load private key first (press k)", "error"));
    return;
  }

  // Capture a per-request seq so a stale decrypt (user opened drill-in,
  // then pressed Esc or opened a different one) cannot push its plaintext
  // back into state. Every state transition that invalidates this request
  // bumps `skillDrillInRequestSeq`; we check equality before dispatching.
  //
  // Compute the new value before dispatching so the local `requestId`
  // does not depend on the dispatch mutator running synchronously. The
  // store's dispatch IS synchronous today, but pinning this here keeps
  // the invariant local to this function instead of leaking out as an
  // implicit contract.
  const requestId = store.getState().sync.skillDrillInRequestSeq + 1;
  store.dispatch((d) => {
    d.sync.skillDrillInRequestSeq = requestId;
  });

  void (async () => {
    try {
      const local = row.sourcePath ? await walkSkillDir(row.sourcePath) : [];

      let vault: { path: string; content: Buffer }[] = [];
      if (row.status !== "local-only" && key) {
        const encrypted = await readFile(row.vaultAbsPath, "utf8");
        const base64 = await decryptString(encrypted, key);
        const buffer = Buffer.from(base64, "base64");
        const entries = await listArchiveEntries(buffer);
        vault = entries.map((e) => ({ path: e.path, content: e.content }));
      }

      const byPath = new Map<string, { local?: Buffer; vault?: Buffer }>();
      for (const e of local) {
        const slot = byPath.get(e.path) ?? {};
        slot.local = e.content;
        byPath.set(e.path, slot);
      }
      for (const e of vault) {
        const slot = byPath.get(e.path) ?? {};
        slot.vault = e.content;
        byPath.set(e.path, slot);
      }

      const files: SkillFile[] = [];
      for (const [path, sides] of byPath) {
        const localBuf = sides.local;
        const vaultBuf = sides.vault;
        let status: SkillFile["status"];
        if (localBuf && vaultBuf) {
          status = sha256(localBuf) === sha256(vaultBuf) ? "synced" : "local-changed";
        } else if (localBuf) {
          status = "local-only";
        } else {
          status = "vault-only";
        }
        const localDecoded = localBuf ? tryDecodeText(localBuf) : null;
        const vaultDecoded = vaultBuf ? tryDecodeText(vaultBuf) : null;
        const isBinary = (localDecoded?.isBinary ?? false) || (vaultDecoded?.isBinary ?? false);
        files.push({
          relPath: path,
          status,
          vaultText: vaultDecoded?.isBinary ? null : (vaultDecoded?.text ?? null),
          localText: localDecoded?.isBinary ? null : (localDecoded?.text ?? null),
          isBinary,
        });
      }
      const sortedFiles = sortSkillFiles(files);

      const fileName = row.vaultPath.split("/").pop() ?? row.vaultPath;
      const bundleName = fileName.replace(/\.tar\.age$/, "");

      store.dispatch((d) => {
        // Refuse to overwrite if the user has moved on (opened a different
        // bundle or pressed Esc) since this request started — that would
        // dump a stale plaintext set into state.
        if (d.sync.skillDrillInRequestSeq !== requestId) return;
        d.sync.skillDrillIn = {
          vaultPath: row.vaultPath,
          bundleName,
          files: sortedFiles,
          cursor: 0,
          scrollOffset: 0,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.dispatch((d) => setToast(d, `Drill-in failed: ${message}`, "error"));
    }
  })();
}

function openDiffForSkillFile(store: Store, file: SkillFile, drillIn: SkillDrillInState): void {
  if (file.isBinary) {
    store.dispatch((d) => setToast(d, `Cannot diff '${file.relPath}' — binary content`, "info"));
    return;
  }
  // Open the diff modal for every textual file inside the bundle — including
  // synced / local-only / vault-only. Synced files render every row as
  // unchanged context (the modal doubles as a viewer); one-sided files
  // appear as +/- against an empty counterpart. Either way the user gets
  // to read the bundle's contents without leaving the TUI.
  store.dispatch((d) => {
    d.sync.diff = {
      vaultPath: `${drillIn.vaultPath}::${file.relPath}`,
      vaultPlain: file.vaultText ?? "",
      localPlain: file.localText ?? "",
      cursor: 0,
      side: "local",
      selectedVault: new Set<number>(),
      selectedLocal: new Set<number>(),
      scrollOffset: 0,
    };
  });
}

function handleSkillDrillInKey(key: KeyEvent, store: Store): boolean {
  const drillIn = store.getState().sync.skillDrillIn;
  if (!drillIn) return false;
  const max = drillIn.files.length;

  if (key.name === "escape" || key.name === "q") {
    store.dispatch((d) => {
      d.sync.skillDrillIn = null;
      // Bump the seq so any decrypt still in flight (slow disk, large
      // bundle) discards its result instead of re-opening the panel.
      d.sync.skillDrillInRequestSeq += 1;
    });
    return true;
  }
  if (key.name === "up") {
    store.dispatch((d) => {
      if (d.sync.skillDrillIn) {
        d.sync.skillDrillIn.cursor = Math.max(0, d.sync.skillDrillIn.cursor - 1);
      }
    });
    return true;
  }
  // Empty bundles produce max === 0; `max - 1` would land on -1 and the
  // cursor index would point off the array. Clamp to a safe last index
  // (0 when empty, max-1 otherwise) for every "move down / end" path.
  const lastIdx = Math.max(0, max - 1);
  if (key.name === "down") {
    store.dispatch((d) => {
      if (d.sync.skillDrillIn) {
        d.sync.skillDrillIn.cursor = Math.min(lastIdx, d.sync.skillDrillIn.cursor + 1);
      }
    });
    return true;
  }
  if (key.name === "pageup") {
    store.dispatch((d) => {
      if (!d.sync.skillDrillIn) return;
      d.sync.skillDrillIn.cursor = Math.max(0, d.sync.skillDrillIn.cursor - PAGE_STEP);
      d.sync.skillDrillIn.scrollOffset = Math.max(0, d.sync.skillDrillIn.scrollOffset - PAGE_STEP);
    });
    return true;
  }
  if (key.name === "pagedown") {
    store.dispatch((d) => {
      if (!d.sync.skillDrillIn) return;
      d.sync.skillDrillIn.cursor = Math.min(lastIdx, d.sync.skillDrillIn.cursor + PAGE_STEP);
      d.sync.skillDrillIn.scrollOffset += PAGE_STEP;
    });
    return true;
  }
  if (key.name === "home") {
    store.dispatch((d) => {
      if (d.sync.skillDrillIn) {
        d.sync.skillDrillIn.cursor = 0;
        d.sync.skillDrillIn.scrollOffset = 0;
      }
    });
    return true;
  }
  if (key.name === "end") {
    store.dispatch((d) => {
      if (d.sync.skillDrillIn) {
        d.sync.skillDrillIn.cursor = lastIdx;
        d.sync.skillDrillIn.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
    });
    return true;
  }
  if ((key.name === "return" || key.name === "d") && !key.shift) {
    const file = drillIn.files[drillIn.cursor];
    if (file) openDiffForSkillFile(store, file, drillIn);
    return true;
  }
  // Swallow everything else so global shortcuts (p, l, x, etc.) don't fire
  // while a drill-in is open; user must press esc to leave.
  return true;
}

export function onSyncKey(key: KeyEvent, store: Store): boolean {
  const s = store.getState().sync;

  // Diff modal: cursor up/down + side switch + space-to-select + c-to-copy.
  // All other keys swallowed so they don't fire underlying tab actions.
  if (s.diff) {
    return handleDiffModalKey(key, store);
  }

  // Skill drill-in panel: arrow nav + enter for per-file diff + esc to close.
  // Sits above the file list but below the diff modal (so opening a per-file
  // diff doesn't dismiss the drill-in).
  if (s.skillDrillIn) {
    return handleSkillDrillInKey(key, store);
  }

  // Confirm-remove modal: y proceeds with runBulkSkillRemove; n/esc cancels.
  if (s.confirmRemove) {
    if (key.name === "y") {
      const items = s.confirmRemove.items.map((it) => ({
        agent: it.agent,
        name: it.name,
        vaultPath: it.vaultPath,
      }));
      store.dispatch((d) => {
        d.sync.confirmRemove = null;
      });
      runBulkSkillRemove(store, items);
      return true;
    }
    if (key.name === "n" || key.name === "escape" || key.name === "q") {
      store.dispatch((d) => {
        d.sync.confirmRemove = null;
        setToast(d, "Remove cancelled", "info");
      });
      return true;
    }
    return true;
  }

  if (s.keyPrompt === "pending") {
    if (key.name === "y") {
      runKeyLoad(store);
      return true;
    }
    if (key.name === "n" || key.name === "escape") {
      store.dispatch((d) => {
        d.sync.keyPrompt = "skipped";
      });
      return true;
    }
    return true;
  }

  if (key.name === "k") {
    store.dispatch((d) => {
      d.sync.keyPrompt = "pending";
    });
    return true;
  }

  if (key.name === "s" && !key.shift) {
    store.dispatch((d) => {
      d.sync.showSynced = !d.sync.showSynced;
      d.sync.cursor = 0;
    });
    return true;
  }

  const visible = navigableRows(store.getState());
  if (visible.length === 0) return false;

  // Escape with no modal open clears the selection set. Frequent reflex,
  // so put it before all other handlers that might match esc.
  if (key.name === "escape") {
    if (store.getState().selection.size > 0) {
      store.dispatch((d) => {
        d.selection.clear();
        setToast(d, "Selection cleared", "info");
      });
      return true;
    }
    return false;
  }

  // Select-all in cursor's section (lowercase a) or across all visible
  // rows (capital A). Both behave as toggles: if every target row is
  // already selected, deselect them; otherwise add the missing ones.
  if (key.name === "a") {
    const targets = key.shift
      ? visible
      : visible.filter((r) => r.status === visible[s.cursor]?.status);
    if (targets.length === 0) return true;
    const sel = store.getState().selection;
    const allSelected = targets.every((r) => sel.has(r.vaultPath));
    store.dispatch((d) => {
      if (allSelected) for (const r of targets) d.selection.delete(r.vaultPath);
      else for (const r of targets) d.selection.add(r.vaultPath);
    });
    return true;
  }

  if (key.name === "c") {
    handleCopyFromFileList(store);
    return true;
  }

  if (key.name === "up") {
    store.dispatch((d) => {
      d.sync.cursor = Math.max(0, d.sync.cursor - 1);
    });
    return true;
  }
  if (key.name === "down") {
    store.dispatch((d) => {
      d.sync.cursor = Math.min(visible.length - 1, d.sync.cursor + 1);
    });
    return true;
  }
  if (key.name === "pageup") {
    store.dispatch((d) => {
      d.sync.cursor = Math.max(0, d.sync.cursor - PAGE_STEP);
      d.sync.scrollOffset = Math.max(0, d.sync.scrollOffset - PAGE_STEP);
    });
    return true;
  }
  if (key.name === "pagedown") {
    store.dispatch((d) => {
      d.sync.cursor = Math.min(visible.length - 1, d.sync.cursor + PAGE_STEP);
      d.sync.scrollOffset += PAGE_STEP;
    });
    return true;
  }
  if (key.name === "home") {
    store.dispatch((d) => {
      d.sync.cursor = 0;
      d.sync.scrollOffset = 0;
    });
    return true;
  }
  if (key.name === "end") {
    store.dispatch((d) => {
      d.sync.cursor = visible.length - 1;
      // Render will clamp scrollOffset to a valid window for the last row.
      d.sync.scrollOffset = Number.MAX_SAFE_INTEGER;
    });
    return true;
  }
  if (key.name === "space") {
    const row = visible[s.cursor];
    if (!row) return false;
    store.dispatch((d) => {
      if (d.selection.has(row.vaultPath)) d.selection.delete(row.vaultPath);
      else d.selection.add(row.vaultPath);
    });
    return true;
  }
  if ((key.name === "return" || key.name === "d") && !key.shift) {
    openDiff(store);
    return true;
  }
  if (key.name === "x" && store.getState().selection.size > 0) {
    // Don't remove immediately — stage a confirmation modal with the exact
    // list. Recovery from an accidental `x` requires git reverts; the modal
    // is the cheap-but-effective guard.
    const items: { agent: string; name: string; vaultPath: string }[] = [];
    const byVaultPath = new Map(s.rows.map((r) => [r.vaultPath, r]));
    const visibleVaultPaths = new Set(visible.map((r) => r.vaultPath));
    let ignoredCount = 0;
    let visibleCount = 0;
    for (const vp of store.getState().selection) {
      const row = byVaultPath.get(vp);
      if (!row?.isSkill) {
        ignoredCount++;
        continue;
      }
      const fileName = row.vaultPath.split("/").pop() ?? "";
      const name = fileName.replace(/\.tar\.age$/, "");
      if (row.agent && name) {
        items.push({ agent: row.agent, name, vaultPath: row.vaultPath });
        if (visibleVaultPaths.has(vp)) visibleCount++;
      }
    }
    if (items.length === 0) {
      store.dispatch((d) =>
        setToast(d, "Nothing to remove — x only removes selected skill bundles", "info"),
      );
      return true;
    }
    store.dispatch((d) => {
      d.sync.confirmRemove = { items, ignoredCount, visibleCount };
    });
    return true;
  }
  // `p` (push) and `l` (pull) are handled at the global level in app.ts
  // via the shared invokeSyncOp → runSyncOp path so every push/pull —
  // regardless of source tab — populates `sync.lastOp` consistently.
  return false;
}

function renderKeyPrompt(renderer: CliRenderer, host: BoxRenderable): void {
  const modal = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: PALETTE.accent,
    borderStyle: "double",
    title: " Load private key ",
    backgroundColor: PALETTE.panelBg,
  });
  modal.add(
    new TextRenderable(renderer, {
      content: [
        "",
        "  Load the vault private key for accurate sync status?",
        "",
        "    [y] yes — decrypt and compare every vault entry",
        "    [n] skip — show '?' status, no decryption (press k later to load)",
        "",
      ].join("\n"),
      fg: PALETTE.text,
      bg: PALETTE.panelBg,
    }),
  );
  host.add(modal);
}

/** Diff modal key handler. Cursor navigates rows; ←/→ switches side;
 *  space toggles selection of the cursor row's line on the active side;
 *  c copies the selected lines (or the full diff if no selection);
 *  esc/q closes the modal. */
function handleDiffModalKey(key: KeyEvent, store: Store): boolean {
  const diff = store.getState().sync.diff;
  if (!diff) return false;
  const rows = pairDiffRows(diff.vaultPlain, diff.localPlain);
  const max = rows.length;
  // Identical-empty pairs (vaultPlain === localPlain === "") yield zero
  // rows. `max - 1` is -1 then; clamp so cursor never lands off the array.
  const lastIdx = Math.max(0, max - 1);

  if (key.name === "escape" || key.name === "q") {
    store.dispatch((d) => {
      d.sync.diff = null;
    });
    return true;
  }
  if (key.name === "up") {
    store.dispatch((d) => {
      if (d.sync.diff) d.sync.diff.cursor = Math.max(0, d.sync.diff.cursor - 1);
    });
    return true;
  }
  if (key.name === "down") {
    store.dispatch((d) => {
      if (d.sync.diff) d.sync.diff.cursor = Math.min(lastIdx, d.sync.diff.cursor + 1);
    });
    return true;
  }
  if (key.name === "pageup") {
    store.dispatch((d) => {
      if (!d.sync.diff) return;
      d.sync.diff.cursor = Math.max(0, d.sync.diff.cursor - PAGE_STEP);
      d.sync.diff.scrollOffset = Math.max(0, d.sync.diff.scrollOffset - PAGE_STEP);
    });
    return true;
  }
  if (key.name === "pagedown") {
    store.dispatch((d) => {
      if (!d.sync.diff) return;
      d.sync.diff.cursor = Math.min(lastIdx, d.sync.diff.cursor + PAGE_STEP);
      d.sync.diff.scrollOffset += PAGE_STEP;
    });
    return true;
  }
  if (key.name === "home") {
    store.dispatch((d) => {
      if (d.sync.diff) {
        d.sync.diff.cursor = 0;
        d.sync.diff.scrollOffset = 0;
      }
    });
    return true;
  }
  if (key.name === "end") {
    store.dispatch((d) => {
      if (d.sync.diff) {
        d.sync.diff.cursor = lastIdx;
        d.sync.diff.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
    });
    return true;
  }
  if (key.name === "left" || key.name === "h") {
    store.dispatch((d) => {
      if (d.sync.diff) d.sync.diff.side = "vault";
    });
    return true;
  }
  if (key.name === "right" || key.name === "l") {
    store.dispatch((d) => {
      if (d.sync.diff) d.sync.diff.side = "local";
    });
    return true;
  }
  if (key.name === "space") {
    const row = rows[diff.cursor];
    if (!row) return true;
    const lineNumber = diff.side === "vault" ? row.lnA : row.lnB;
    if (lineNumber === null) {
      store.dispatch((d) => setToast(d, `No ${diff.side}-side line on this row`, "info"));
      return true;
    }
    store.dispatch((d) => {
      if (!d.sync.diff) return;
      const set =
        d.sync.diff.side === "vault" ? d.sync.diff.selectedVault : d.sync.diff.selectedLocal;
      if (set.has(lineNumber)) set.delete(lineNumber);
      else set.add(lineNumber);
    });
    return true;
  }
  if (key.name === "c") {
    handleCopyFromDiff(store);
    return true;
  }
  if (key.name === "a") {
    // Select all lines on the current side that have a real line number.
    const side = diff.side;
    const lineNumbers: number[] = [];
    for (const r of rows) {
      const ln = side === "vault" ? r.lnA : r.lnB;
      if (ln !== null) lineNumbers.push(ln);
    }
    const targetSet = side === "vault" ? diff.selectedVault : diff.selectedLocal;
    const allSelected = lineNumbers.every((ln) => targetSet.has(ln));
    store.dispatch((d) => {
      if (!d.sync.diff) return;
      const set =
        d.sync.diff.side === "vault" ? d.sync.diff.selectedVault : d.sync.diff.selectedLocal;
      if (allSelected) for (const ln of lineNumbers) set.delete(ln);
      else for (const ln of lineNumbers) set.add(ln);
    });
    return true;
  }
  return true;
}

function handleCopyFromFileList(store: Store): void {
  const state = store.getState();
  const visible = navigableRows(state);
  let text = "";
  let label = "";
  if (state.selection.size > 0) {
    const sorted = [...state.selection].sort();
    text = sorted.join("\n");
    label = `${sorted.length} path(s)`;
  } else {
    const row = visible[state.sync.cursor];
    if (!row) {
      store.dispatch((d) => setToast(d, "Nothing to copy", "info"));
      return;
    }
    text = row.sourcePath ?? row.vaultPath;
    label = "1 path";
  }
  copyToClipboard(text);
  store.dispatch((d) => setToast(d, `Copied ${label} to clipboard`, "success"));
}

function handleCopyFromDiff(store: Store): void {
  const diff = store.getState().sync.diff;
  if (!diff) return;
  const rows = pairDiffRows(diff.vaultPlain, diff.localPlain);
  // Collect selected lines per side in source order.
  const lines: string[] = [];
  let count = 0;
  if (diff.selectedVault.size > 0) {
    const vaultLines = diff.vaultPlain.split("\n");
    for (const ln of [...diff.selectedVault].sort((x, y) => x - y)) {
      lines.push(vaultLines[ln - 1] ?? "");
      count++;
    }
  }
  if (diff.selectedLocal.size > 0) {
    if (lines.length > 0) lines.push(""); // blank between sides
    const localLines = diff.localPlain.split("\n");
    for (const ln of [...diff.selectedLocal].sort((x, y) => x - y)) {
      lines.push(localLines[ln - 1] ?? "");
      count++;
    }
  }
  if (count === 0) {
    // No per-line selection — fall back to copying the whole row-pair
    // diff as text (matches what was on screen).
    const text = rows
      .map((r) => `${r.sigA}${r.textA.padEnd(40)} | ${r.sigB}${r.textB}`.trimEnd())
      .join("\n");
    copyToClipboard(text);
    store.dispatch((d) => setToast(d, "Copied full diff", "success"));
    return;
  }
  copyToClipboard(lines.join("\n"));
  store.dispatch((d) => setToast(d, `Copied ${count} line(s)`, "success"));
}

/**
 * Render the diff modal as a colored two-column layout. Each row is a
 * horizontal Box with two TextRenderables (vault | local), coloured red
 * for the vault deletion side, green for the local addition side, dim for
 * unchanged context. The cursor row is highlighted; selected lines get a
 * different background so the user can see what's queued for copy.
 */
function renderDiffModal(renderer: CliRenderer, host: BoxRenderable, diff: DiffModalState): void {
  const rows = pairDiffRows(diff.vaultPlain, diff.localPlain);
  const totalWidth = Math.max(40, renderer.terminalWidth ?? 100);
  const terminalHeight = renderer.terminalHeight ?? 40;
  const viewportHeight = Math.max(5, terminalHeight - CHROME_HEIGHT_RESERVE - 2);

  const useSideBySide = totalWidth >= SIDE_BY_SIDE_MIN_WIDTH;
  const sideHint = useSideBySide
    ? `  [${diff.side === "vault" ? "←vault" : " vault"}|${diff.side === "local" ? "local→" : "local "}]`
    : "";

  const box = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    flexDirection: "column",
    border: true,
    borderColor: PALETTE.accent,
    borderStyle: "double",
    title: ` diff: ${stripAge(diff.vaultPath)}${sideHint}  (esc to close, ←→ side, space select, c copy) `,
    backgroundColor: PALETTE.panelBg,
  });
  host.add(box);

  if (rows.length === 0) {
    box.add(
      new TextRenderable(renderer, {
        content: "\n  (no textual difference)",
        fg: PALETTE.textDim,
        bg: PALETTE.panelBg,
      }),
    );
    return;
  }

  // Clamp scroll to keep cursor in view.
  const maxOffset = Math.max(0, rows.length - viewportHeight);
  let scrollOffset = Math.min(diff.scrollOffset, maxOffset);
  scrollOffset = Math.max(0, scrollOffset);
  if (diff.cursor < scrollOffset) scrollOffset = diff.cursor;
  else if (diff.cursor >= scrollOffset + viewportHeight) {
    scrollOffset = diff.cursor - viewportHeight + 1;
  }

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(rows.length, scrollOffset + viewportHeight);

  if (useSideBySide) {
    renderSideBySideRows(renderer, box, diff, rows, visibleStart, visibleEnd, totalWidth);
  } else {
    renderUnifiedRows(renderer, box, diff, rows, visibleStart, visibleEnd, totalWidth);
  }

  if (rows.length > viewportHeight) {
    box.add(
      new TextRenderable(renderer, {
        content: `  ${visibleStart + 1}–${visibleEnd} of ${rows.length}`,
        fg: PALETTE.textDim,
        bg: PALETTE.panelBg,
      }),
    );
  }
}

function rowFg(
  side: "vault" | "local",
  row: SideBySideRow,
  isCursor: boolean,
  isSelected: boolean,
): { fg: string; bg: string } {
  let fg = PALETTE.textDim;
  if (side === "vault" && row.sigA === "-") fg = PALETTE.bad;
  if (side === "local" && row.sigB === "+") fg = PALETTE.good;
  if (row.sigA === " " && row.sigB === " ") fg = PALETTE.text;
  let bg = PALETTE.panelBg;
  if (isSelected) bg = "#2e3440";
  if (isCursor) bg = "#3b4252";
  return { fg, bg };
}

function renderSideBySideRows(
  renderer: CliRenderer,
  parent: BoxRenderable,
  diff: DiffModalState,
  rows: SideBySideRow[],
  start: number,
  end: number,
  totalWidth: number,
): void {
  const gutter = 3;
  const lnW = Math.max(
    3,
    String(Math.max(...rows.flatMap((r) => [r.lnA ?? 0, r.lnB ?? 0]))).length,
  );
  // 2 = padding before each side; 2 = sig+space prefix.
  const sideWidth = Math.max(8, Math.floor((totalWidth - gutter - 4 - lnW * 2 - 4) / 2));

  for (let i = start; i < end; i++) {
    const row = rows[i];
    const isCursor = i === diff.cursor;
    const isSelVault = row.lnA !== null && diff.selectedVault.has(row.lnA);
    const isSelLocal = row.lnB !== null && diff.selectedLocal.has(row.lnB);

    const rowBox = new BoxRenderable(renderer, {
      flexDirection: "row",
      width: "100%",
      height: 1,
      backgroundColor: PALETTE.panelBg,
    });

    const vaultColors = rowFg("vault", row, isCursor && diff.side === "vault", isSelVault);
    const localColors = rowFg("local", row, isCursor && diff.side === "local", isSelLocal);

    const cursorMark = isCursor ? "▶" : " ";
    const vaultLn = row.lnA === null ? " ".repeat(lnW) : String(row.lnA).padStart(lnW);
    const localLn = row.lnB === null ? " ".repeat(lnW) : String(row.lnB).padStart(lnW);
    const vaultText = truncate(row.textA, sideWidth);
    const localText = truncate(row.textB, sideWidth);

    rowBox.add(
      new TextRenderable(renderer, {
        content: ` ${diff.side === "vault" ? cursorMark : " "}${isSelVault ? "✓" : " "}${vaultLn} ${row.sigA}${vaultText}`,
        fg: vaultColors.fg,
        bg: vaultColors.bg,
      }),
    );
    rowBox.add(
      new TextRenderable(renderer, {
        content: " │ ",
        fg: PALETTE.border,
        bg: PALETTE.panelBg,
      }),
    );
    rowBox.add(
      new TextRenderable(renderer, {
        content: ` ${diff.side === "local" ? cursorMark : " "}${isSelLocal ? "✓" : " "}${localLn} ${row.sigB}${localText}`,
        fg: localColors.fg,
        bg: localColors.bg,
      }),
    );

    parent.add(rowBox);
  }
}

function renderUnifiedRows(
  renderer: CliRenderer,
  parent: BoxRenderable,
  diff: DiffModalState,
  rows: SideBySideRow[],
  start: number,
  end: number,
  totalWidth: number,
): void {
  // Narrow terminal — stack the two sides as classic unified diff.
  const lnW = Math.max(
    3,
    String(Math.max(...rows.flatMap((r) => [r.lnA ?? 0, r.lnB ?? 0]))).length,
  );
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const isCursor = i === diff.cursor;

    if (row.sigA === " " && row.sigB === " ") {
      parent.add(
        new TextRenderable(renderer, {
          content: `${isCursor ? "▶" : " "} ${String(row.lnA).padStart(lnW)}   ${truncate(row.textA, totalWidth - lnW - 6)}`,
          fg: PALETTE.text,
          bg: isCursor ? "#3b4252" : PALETTE.panelBg,
        }),
      );
      continue;
    }
    if (row.sigA === "-") {
      const isSel = row.lnA !== null && diff.selectedVault.has(row.lnA);
      parent.add(
        new TextRenderable(renderer, {
          content: `${isCursor && diff.side === "vault" ? "▶" : " "}${isSel ? "✓" : " "}${row.lnA === null ? " ".repeat(lnW) : String(row.lnA).padStart(lnW)} -${truncate(row.textA, totalWidth - lnW - 6)}`,
          fg: PALETTE.bad,
          bg: isCursor && diff.side === "vault" ? "#3b4252" : PALETTE.panelBg,
        }),
      );
    }
    if (row.sigB === "+") {
      const isSel = row.lnB !== null && diff.selectedLocal.has(row.lnB);
      parent.add(
        new TextRenderable(renderer, {
          content: `${isCursor && diff.side === "local" ? "▶" : " "}${isSel ? "✓" : " "}${row.lnB === null ? " ".repeat(lnW) : String(row.lnB).padStart(lnW)} +${truncate(row.textB, totalWidth - lnW - 6)}`,
          fg: PALETTE.good,
          bg: isCursor && diff.side === "local" ? "#3b4252" : PALETTE.panelBg,
        }),
      );
    }
  }
}

const SKILL_FILE_STATUS_VERB: Record<SkillFile["status"], string> = {
  synced: "synced",
  "local-changed": "modified",
  "local-only": "new",
  "vault-only": "missing",
};

function renderSkillDrillIn(
  renderer: CliRenderer,
  host: BoxRenderable,
  drillIn: SkillDrillInState,
): void {
  const terminalHeight = renderer.terminalHeight ?? 40;
  const totalWidth = Math.max(40, renderer.terminalWidth ?? 100);
  const viewportHeight = Math.max(5, terminalHeight - CHROME_HEIGHT_RESERVE);

  const counts: Record<SkillFile["status"], number> = {
    synced: 0,
    "local-changed": 0,
    "local-only": 0,
    "vault-only": 0,
  };
  for (const f of drillIn.files) counts[f.status]++;
  const summary = (
    [
      counts.synced ? `${counts.synced} synced` : "",
      counts["local-changed"] ? `${counts["local-changed"]} changed` : "",
      counts["local-only"] ? `${counts["local-only"]} new` : "",
      counts["vault-only"] ? `${counts["vault-only"]} missing` : "",
    ].filter(Boolean) as string[]
  ).join(" · ");

  const box = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    flexDirection: "column",
    border: true,
    borderColor: PALETTE.accent,
    borderStyle: "double",
    title: ` Skill: ${drillIn.bundleName}${summary ? ` · ${summary}` : ""}  (enter: diff · esc: back) `,
    backgroundColor: PALETTE.panelBg,
  });
  host.add(box);

  if (drillIn.files.length === 0) {
    box.add(
      new TextRenderable(renderer, {
        content: "\n  (bundle is empty)",
        fg: PALETTE.textDim,
        bg: PALETTE.panelBg,
      }),
    );
    return;
  }

  // `drillIn.files` is already sorted in render order (status group, then
  // alphabetical within group) by `sortSkillFiles`. Iterating in order
  // here means the cursor index lines up with the row a user sees moving
  // up/down — no re-grouping, no order skew.
  //
  // Precompute one group-count per status before the loop so the per-row
  // body stays O(1). Without this, the section header would re-filter the
  // whole `files` array on every render — fine for typical skill bundles
  // but unbounded as bundle size grows.
  const groupCounts = new Map<SkillFile["status"], number>();
  for (const f of drillIn.files) {
    groupCounts.set(f.status, (groupCounts.get(f.status) ?? 0) + 1);
  }
  const verbW = 10;
  const lines: string[] = [];
  let cursorLineIdx = -1;
  let prevStatus: SkillFile["status"] | null = null;

  for (let i = 0; i < drillIn.files.length; i++) {
    const f = drillIn.files[i];
    if (f.status !== prevStatus) {
      lines.push("");
      lines.push(`  ${SKILL_FILE_STATUS_VERB[f.status]} (${groupCounts.get(f.status) ?? 0})`);
      prevStatus = f.status;
    }
    const isCursor = i === drillIn.cursor;
    if (isCursor) cursorLineIdx = lines.length;
    const cursorMark = isCursor ? "▶" : " ";
    const verb = truncate(`${SKILL_FILE_STATUS_VERB[f.status]}:`, verbW);
    const binTag = f.isBinary ? "  (binary)" : "";
    lines.push(truncate(`  ${cursorMark}  ${verb} ${f.relPath}${binTag}`, totalWidth - 2));
  }

  const maxOffset = Math.max(0, lines.length - viewportHeight);
  let scrollOffset = Math.min(drillIn.scrollOffset, maxOffset);
  scrollOffset = Math.max(0, scrollOffset);
  if (cursorLineIdx >= 0) {
    if (cursorLineIdx < scrollOffset) scrollOffset = cursorLineIdx;
    else if (cursorLineIdx >= scrollOffset + viewportHeight) {
      scrollOffset = cursorLineIdx - viewportHeight + 1;
    }
  }
  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);
  if (lines.length > viewportHeight) {
    const arrows = `${scrollOffset > 0 ? "↑" : " "}${scrollOffset + viewportHeight < lines.length ? "↓" : " "}`;
    visibleLines.push("");
    visibleLines.push(
      `  ${arrows}  ${scrollOffset + 1}–${Math.min(lines.length, scrollOffset + viewportHeight)} of ${lines.length}`,
    );
  }

  box.add(
    new TextRenderable(renderer, {
      content: visibleLines.join("\n"),
      fg: PALETTE.text,
      bg: PALETTE.panelBg,
    }),
  );
}

function renderConfirmRemove(
  renderer: CliRenderer,
  host: BoxRenderable,
  confirm: {
    items: { agent: string; name: string; vaultPath: string }[];
    ignoredCount: number;
    visibleCount: number;
  },
): void {
  const modal = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: PALETTE.bad,
    borderStyle: "double",
    title: ` Confirm skill remove (x) `,
    backgroundColor: PALETTE.panelBg,
  });
  const itemLines = confirm.items.slice(0, 20).map((it) => `    ${it.vaultPath}`);
  if (confirm.items.length > 20) {
    itemLines.push(`    … and ${confirm.items.length - 20} more`);
  }
  const hiddenCount = confirm.items.length - confirm.visibleCount;
  const lines = [
    "",
    `  Remove ${confirm.items.length} skill(s) from vault?`,
    "  This runs `git rm` + commit + push. Reversible only via `git revert`.",
    "",
  ];
  if (hiddenCount > 0) {
    // The user pressed `x` thinking they were acting on visible selections,
    // but their selection set also contains items from collapsed sections.
    // Surface that gap loudly so they don't lose data twice.
    lines.push(
      `  ⚠  ${confirm.visibleCount} visible on screen + ${hiddenCount} from collapsed/hidden sections.`,
    );
    lines.push("     Press n to cancel, then esc to clear selection, then re-select.");
    lines.push("");
  }
  lines.push(...itemLines);
  lines.push("");
  if (confirm.ignoredCount > 0) {
    lines.push(`  (${confirm.ignoredCount} non-skill selection(s) will be ignored)`);
    lines.push("");
  }
  lines.push("    [y] yes — remove");
  lines.push("    [n] cancel");

  modal.add(
    new TextRenderable(renderer, {
      content: lines.join("\n"),
      fg: PALETTE.text,
      bg: PALETTE.panelBg,
    }),
  );
  host.add(modal);
}

function summaryLine(rows: SyncRow[], selectionCount: number): string {
  const counts: Record<SyncRow["status"], number> = {
    synced: 0,
    "local-changed": 0,
    "local-only": 0,
    "vault-only": 0,
    unknown: 0,
    error: 0,
  };
  for (const r of rows) counts[r.status]++;
  const parts: string[] = [];
  if (counts.synced) parts.push(`${counts.synced} synced`);
  if (counts["local-changed"]) parts.push(`${counts["local-changed"]} changed`);
  if (counts["local-only"]) parts.push(`${counts["local-only"]} local-only`);
  if (counts["vault-only"]) parts.push(`${counts["vault-only"]} vault-only`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown`);
  if (counts.error) parts.push(`${counts.error} error`);
  // Selection count is the bit that was previously invisible until destructive
  // ops fired — surfacing it in the title means the user always knows what
  // would happen if they press x or c.
  if (selectionCount > 0) parts.push(`★ ${selectionCount} selected`);
  return parts.length === 0 ? "empty" : parts.join(" · ");
}

export function renderSync(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const s = state.sync;
  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: PALETTE.panelBg,
  });
  host.add(wrapper);

  if (s.diff) {
    renderDiffModal(renderer, wrapper, s.diff);
    return;
  }
  if (s.confirmRemove) {
    renderConfirmRemove(renderer, wrapper, s.confirmRemove);
    return;
  }
  if (s.keyPrompt === "pending") {
    renderKeyPrompt(renderer, wrapper);
    return;
  }
  if (s.skillDrillIn) {
    renderSkillDrillIn(renderer, wrapper, s.skillDrillIn);
    return;
  }

  // Persistent banner for the most recent push/pull. Stays visible until
  // the next op runs — toasts fade in 3s and that's too short for the
  // terminal-level error messages the user needs to read and act on. When
  // `details` is present (per-file secret-detection errors), each detail
  // gets its own indented line so file paths aren't truncated.
  if (s.lastOp) {
    const lo = s.lastOp;
    const fg =
      lo.status === "error" ? PALETTE.bad : lo.status === "running" ? PALETTE.warn : PALETTE.good;
    const verb = lo.kind === "push" ? "Push" : "Pull";
    const tag = lo.status === "error" ? "FAILED" : lo.status === "running" ? "running…" : "ok";
    const bannerLines = [`  ${verb} ${tag} — ${lo.message}`];
    if (lo.details && lo.details.length > 0) {
      for (const d of lo.details) bannerLines.push(`    ${d}`);
    }
    const banner = new TextRenderable(renderer, {
      height: bannerLines.length,
      width: "100%",
      content: bannerLines.join("\n"),
      fg,
      bg: PALETTE.panelBg,
    });
    wrapper.add(banner);
  }

  const listBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: PALETTE.border,
    borderStyle: "single",
    title: ` Sync · ${summaryLine(s.rows, state.selection.size)} `,
    backgroundColor: PALETTE.panelBg,
  });
  wrapper.add(listBox);

  if (s.phase === "error") {
    listBox.add(
      new TextRenderable(renderer, {
        content: `  Cannot compute status: ${s.error}\n  Run \`agentsync init\` first.`,
        fg: PALETTE.bad,
        bg: PALETTE.panelBg,
      }),
    );
    return;
  }
  if (s.phase === "loading" || s.phase === "idle") {
    listBox.add(
      new TextRenderable(renderer, {
        content: "\n  Computing sync status…",
        fg: PALETTE.textDim,
        bg: PALETTE.panelBg,
      }),
    );
    return;
  }

  if (s.rows.length === 0) {
    listBox.add(
      new TextRenderable(renderer, {
        content: "\n  No tracked artifacts. Run `agentsync init` and `push`.",
        fg: PALETTE.textDim,
        bg: PALETTE.panelBg,
      }),
    );
    return;
  }

  const totalWidth = Math.max(40, renderer.terminalWidth ?? 100);
  const groups = groupByStatus(s.rows);
  const navIndex = navigableRows(state);
  // The cursor row's vaultPath is the cheapest stable identifier — comparing
  // by reference would break when render-time `groupByStatus` allocates fresh
  // arrays.
  const cursorPath = navIndex[s.cursor]?.vaultPath;

  // Verb column width — fits "modified:" (9 chars) plus the trailing colon
  // we render inline. Picked so every section's rows line up consistently.
  const verbW = 10;
  const lines: string[] = [];
  let cursorLineIdx = -1;

  if (s.keyPrompt === "skipped") {
    lines.push(
      `  ${truncate("· private key skipped — statuses are '?'  (press k to load)", totalWidth - 4)}`,
    );
    lines.push("");
  }

  // Drift sections always render their header — even at count 0 — so the
  // categories are visible and the user learns that vault-only drift is a
  // thing the panel tracks before it ever appears. Transient sections
  // (error, unknown) and synced stay conditional.
  const ALWAYS_SHOW_HEADERS: ReadonlySet<SyncRow["status"]> = new Set([
    "local-changed",
    "local-only",
    "vault-only",
  ]);
  for (const section of SECTIONS) {
    const rows = groups.get(section.key) ?? [];
    if (rows.length === 0 && !ALWAYS_SHOW_HEADERS.has(section.key)) continue;

    if (section.key === "synced" && !state.sync.showSynced) {
      lines.push("");
      lines.push(`  ✓ ${section.title} (${rows.length})  —  ${section.hint}`);
      continue;
    }

    lines.push("");
    lines.push(`  ${section.title} (${rows.length})  —  ${section.hint}`);
    for (const r of rows) {
      const isCursor = r.vaultPath === cursorPath;
      if (isCursor) cursorLineIdx = lines.length;
      const cursorMark = isCursor ? "▶" : " ";
      const selMark = state.selection.has(r.vaultPath) ? "✓" : r.isSkill ? "·" : " ";
      const verb = truncate(`${STATUS_VERB[r.status]}:`, verbW);
      const path = r.sourcePath ? stripAge(r.displayName) : stripAge(r.vaultPath);
      const rowText = `  ${cursorMark}${selMark} ${verb} ${path}`;
      lines.push(truncate(rowText, totalWidth - 2));
    }
  }

  // Scrollable viewport. We derive an effective scroll offset from
  // `state.sync.scrollOffset` (user-controlled via PageUp/PageDown/Home/End)
  // and force-clamp it so the cursor row is always visible. This means
  // arrow-key cursor moves auto-scroll the view without any state update,
  // while explicit scroll keys still let the user reposition the viewport.
  const terminalHeight = renderer.terminalHeight ?? 40;
  const viewportHeight = Math.max(5, terminalHeight - CHROME_HEIGHT_RESERVE);
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  let scrollOffset = Math.min(s.scrollOffset, maxOffset);
  scrollOffset = Math.max(0, scrollOffset);
  if (cursorLineIdx >= 0) {
    if (cursorLineIdx < scrollOffset) scrollOffset = cursorLineIdx;
    else if (cursorLineIdx >= scrollOffset + viewportHeight) {
      scrollOffset = cursorLineIdx - viewportHeight + 1;
    }
  }
  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);

  // Scroll affordance — show position so the user knows there's more above
  // or below the visible window. Empty when the entire list fits.
  if (lines.length > viewportHeight) {
    const pct = Math.round(((scrollOffset + viewportHeight) / lines.length) * 100);
    const arrows = `${scrollOffset > 0 ? "↑" : " "}${scrollOffset + viewportHeight < lines.length ? "↓" : " "}`;
    visibleLines.push("");
    visibleLines.push(
      `  ${arrows}  ${scrollOffset + 1}–${Math.min(lines.length, scrollOffset + viewportHeight)} of ${lines.length}  (${Math.min(100, pct)}%)`,
    );
  }

  listBox.add(
    new TextRenderable(renderer, {
      content: visibleLines.join("\n"),
      fg: PALETTE.text,
      bg: PALETTE.panelBg,
    }),
  );
}
