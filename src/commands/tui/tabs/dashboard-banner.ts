import { version as pkgVersion } from "../../../../package.json";
import type { AppState } from "../state";

/** Banner line for the Dashboard. An available update takes over the line so
 *  it is the first thing the user sees; otherwise it shows the daemon hint.
 *  Kept separate from the OpenTUI render code so the choice of message stays
 *  unit-testable without a terminal renderer. */
export function dashboardBannerContent(state: AppState): string {
  const { update } = state;
  if (update.available && update.latest) {
    const head = `  ⬆ Update available: v${pkgVersion} → v${update.latest}`;
    return update.method === "npm-global"
      ? `${head} · press u to update`
      : `${head} · github.com/chrisleekr/agentsync/releases`;
  }
  return state.daemon.online
    ? "  Welcome back. Press a tab number to drill in, or p/l to sync."
    : "  No daemon detected. Run `agentsync daemon start` to enable live sync, or browse offline.";
}
