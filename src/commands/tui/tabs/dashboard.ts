import type { CliRenderer } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { AppState } from "../state";
import { dashboardBannerContent } from "./dashboard-banner";

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
