import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../state";
import { dashboardBannerContent } from "../dashboard-banner";

describe("dashboardBannerContent", () => {
  test("shows the welcome hint when no update is available", () => {
    const state = createInitialState();
    expect(dashboardBannerContent(state)).toContain("Welcome back");
  });

  test("an npm-global update banner invites the u key", () => {
    const state = createInitialState();
    state.update = { latest: "9.9.9", available: true, method: "npm-global" };
    const banner = dashboardBannerContent(state);
    expect(banner).toContain("9.9.9");
    expect(banner).toContain("press u");
  });

  test("a standalone update banner points at the releases page instead", () => {
    const state = createInitialState();
    state.update = { latest: "9.9.9", available: true, method: "standalone" };
    const banner = dashboardBannerContent(state);
    expect(banner).toContain("9.9.9");
    expect(banner).toContain("releases");
    expect(banner).not.toContain("press u");
  });
});
