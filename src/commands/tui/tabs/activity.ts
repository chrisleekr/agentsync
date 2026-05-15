import type { CliRenderer } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { AppState } from "../state";

export function renderActivity(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
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
    title: " Activity (this session) ",
    backgroundColor: "#11151a",
  });
  wrapper.add(box);

  if (state.activity.length === 0) {
    box.add(
      new TextRenderable(renderer, {
        content: "\n  No activity this session. Push, pull, or browse to log entries here.",
        fg: "#6c7886",
        bg: "#11151a",
      }),
    );
    return;
  }

  const rows = state.activity.slice(0, 50).map((a) => {
    const ts = a.ts.toTimeString().slice(0, 8);
    const status = a.status.padEnd(7);
    const kind = a.kind.padEnd(10);
    return `  ${ts}  ${kind}  ${status}  ${a.message}`;
  });
  box.add(
    new TextRenderable(renderer, {
      content: rows.join("\n"),
      fg: "#d8dee9",
      bg: "#11151a",
    }),
  );
}
