import { describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { clearChildren } from "../renderables";

describe("clearChildren", () => {
  test("removes each renderable by object identity", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });

    try {
      const host = new BoxRenderable(renderer, {});
      renderer.root.add(host);
      const first = new TextRenderable(renderer, { content: "first" });
      const second = new TextRenderable(renderer, { content: "second" });
      host.add(first);
      host.add(second);

      clearChildren(host);

      expect(host.getChildrenCount()).toBe(0);
      expect(host.getChildren()).not.toContain(first);
      expect(host.getChildren()).not.toContain(second);
    } finally {
      renderer.destroy();
    }
  });
});
