import { performVaultRemove } from "../../vault-remove";
import type { Store } from "../store";

/**
 * Bulk-remove a list of vault artifacts (skills, commands, configs, rules)
 * via the shared performVaultRemove core. Reports the ok/fail tally back
 * through the store toast. Lives outside any tab module so future tabs can
 * call it without coupling to the Sync tab's internal layout.
 */
export function runBulkVaultRemove(store: Store, vaultPaths: string[]): void {
  if (vaultPaths.length === 0) return;

  store.runOperation(
    "vault-rm",
    `remove ${vaultPaths.length} artifact(s)`,
    async () => {
      const removed: string[] = [];
      let ok = 0;
      let fail = 0;
      for (const vaultPath of vaultPaths) {
        const r = await performVaultRemove({ vaultRelPath: vaultPath });
        if (r.status === "success") {
          ok++;
          removed.push(vaultPath);
        } else {
          fail++;
        }
      }
      return { ok, fail, removed };
    },
    {
      activityKind: "vault-rm",
      onSuccess: (draft, result) => {
        const { ok, fail, removed } = result as {
          ok: number;
          fail: number;
          removed: string[];
        };
        // Only drop selection entries that were actually removed. A total
        // failure (ok === 0) leaves the user's selection set intact so they
        // can retry without re-selecting from scratch.
        for (const vp of removed) draft.selection.delete(vp);
        // Force the sync tab to reload so removed artifacts disappear from the
        // row list. The loader is idle-gated, so flipping the phase back to
        // idle is enough to retrigger on next ensureSyncLoaded.
        draft.sync.phase = "idle";
        const text = `Removed ${ok} artifact(s)${fail > 0 ? `, ${fail} failed` : ""}`;
        draft.toast = {
          text,
          level: fail === 0 ? "success" : "error",
          expiresAt: Date.now() + 3000,
        };
      },
    },
  );
}
