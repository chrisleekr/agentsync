import { performSkillRemove } from "../../skill";
import type { Store } from "../store";

export interface SkillTarget {
  agent: string;
  name: string;
}

/**
 * Bulk-remove a list of skill bundles via the shared performSkillRemove
 * helper. Reports the ok/fail tally back through the store toast. Lives
 * outside any tab module so future tabs can call it without coupling to
 * the Vault tab's internal layout.
 */
export function runBulkSkillRemove(
  store: Store,
  items: (SkillTarget & { vaultPath?: string })[],
): void {
  if (items.length === 0) return;

  store.runOperation(
    "skill-rm",
    `remove ${items.length} skill(s)`,
    async () => {
      const removedVaultPaths: string[] = [];
      let ok = 0;
      let fail = 0;
      for (const item of items) {
        const r = await performSkillRemove(item);
        if (r.status === "success") {
          ok++;
          // vaultPath is supplied by the Sync tab; older callers may omit
          // it (no selection state to prune in that case).
          if (item.vaultPath) removedVaultPaths.push(item.vaultPath);
        } else {
          fail++;
        }
      }
      return { ok, fail, removedVaultPaths };
    },
    {
      activityKind: "skill-rm",
      onSuccess: (draft, result) => {
        const { ok, fail, removedVaultPaths } = result as {
          ok: number;
          fail: number;
          removedVaultPaths: string[];
        };
        // Only drop selection entries that were actually removed. A total
        // failure (ok === 0) leaves the user's selection set intact so
        // they can retry without re-selecting from scratch.
        for (const vp of removedVaultPaths) draft.selection.delete(vp);
        // Force the sync tab to reload so removed skills disappear from
        // the row list. The loader is idle-gated, so flipping the phase
        // back to idle is enough to retrigger on next ensureSyncLoaded.
        draft.sync.phase = "idle";
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
