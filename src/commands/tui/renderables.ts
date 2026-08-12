import type { BoxRenderable } from "@opentui/core";

export function clearChildren(host: BoxRenderable): void {
  for (const child of [...host.getChildren()]) {
    host.remove(child);
  }
}
