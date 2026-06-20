import type { CliRenderer } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { type AppState, countRunning } from "../state";
import { dashboardBannerContent } from "./dashboard-banner";

function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m - h * 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function renderDashboard(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: "#11151a",
    border: false,
  });
  host.add(wrapper);

  const banner = new TextRenderable(renderer, {
    height: 3,
    width: "100%",
    fg: "#ebcb8b",
    bg: "#11151a",
    content: dashboardBannerContent(state),
  });
  wrapper.add(banner);

  // Daemon panel
  const daemonPid = state.daemon.status?.pid ?? "—";
  const daemonFails = state.daemon.status?.consecutiveFailures ?? 0;
  const daemonLastErr = state.daemon.status?.lastError ?? "—";
  const lastSuccessAt = state.daemon.status?.lastSuccessAt ?? null;
  const stuck = state.daemon.status?.stuck ?? false;
  const lastSync = lastSuccessAt
    ? `${fmtDuration(Date.now() - Date.parse(lastSuccessAt))} ago`
    : "never";
  const uptime =
    state.daemon.online && state.daemon.pidObservedAt
      ? fmtDuration(Date.now() - state.daemon.pidObservedAt)
      : "—";
  const running = countRunning(state);
  const daemonText = [
    "",
    `  status   ${state.daemon.online ? "● running" : "○ stopped"}`,
    `  pid      ${daemonPid}`,
    `  uptime   ${uptime} (since this TUI started)`,
    `  lastSync ${lastSync}`,
    `  fails    ${daemonFails}`,
    `  lastErr  ${daemonLastErr}`,
    `  inFlight ${running > 0 ? `${running} op(s) running` : "idle"}`,
    ...(stuck ? ["  ⚠ STUCK: vault diverged — reset the vault, auto-sync is paused"] : []),
    "",
  ].join("\n");
  const daemonBox = new BoxRenderable(renderer, {
    height: stuck ? 13 : 12,
    width: "100%",
    border: true,
    borderColor: stuck ? "#bf616a" : "#3b4252",
    borderStyle: "single",
    title: " Daemon ",
    backgroundColor: "#11151a",
  });
  daemonBox.add(
    new TextRenderable(renderer, {
      content: daemonText,
      fg: "#d8dee9",
      bg: "#11151a",
    }),
  );
  wrapper.add(daemonBox);

  // Hint panel
  const hint = new TextRenderable(renderer, {
    height: 7,
    width: "100%",
    fg: "#6c7886",
    bg: "#11151a",
    content: [
      "",
      "  [2] Sync     side-by-side vault ↔ local with status, diff, push",
      "  [3] Machines browse other machines' namespaces and copy from them",
      "  [4] Migrate  translate config from one agent to another",
      "  [5] Activity recent operation log",
      "  [6] Config   toggle agents, sync, and security policy",
    ].join("\n"),
  });
  wrapper.add(hint);
}
