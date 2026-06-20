import { describe, expect, test } from "bun:test";
import { mergePreservingSecrets } from "../secret-merge";

const PH = "$AGENTSYNC_REDACTED_KEY";

describe("mergePreservingSecrets", () => {
  test("an incoming placeholder never overwrites a real local value", () => {
    const { merged, placeholders } = mergePreservingSecrets(
      { srv: { env: { KEY: "sk-real-local" } } },
      { srv: { env: { KEY: PH } } },
    );
    expect((merged as { srv: { env: { KEY: string } } }).srv.env.KEY).toBe("sk-real-local");
    expect(placeholders).toEqual([]); // nothing left needing a value
  });

  test("a placeholder with no local value is written and reported", () => {
    const { merged, placeholders } = mergePreservingSecrets({}, { srv: { env: { KEY: PH } } });
    expect((merged as { srv: { env: { KEY: string } } }).srv.env.KEY).toBe(PH);
    expect(placeholders).toEqual(["srv.env.KEY"]);
  });

  test("local-only keys survive the merge (copy is additive)", () => {
    const { merged } = mergePreservingSecrets(
      { localOnly: { command: "z" }, shared: 1 },
      { shared: 2 },
    );
    const m = merged as { localOnly: unknown; shared: number };
    expect(m.localOnly).toEqual({ command: "z" });
    expect(m.shared).toBe(2); // incoming wins for shared keys
  });

  test("an incoming real value overwrites the local one (normal sync)", () => {
    const { merged } = mergePreservingSecrets({ k: "old" }, { k: "new" });
    expect((merged as { k: string }).k).toBe("new");
  });

  test("a local placeholder counts as no value, so the incoming placeholder is taken", () => {
    const { merged, placeholders } = mergePreservingSecrets({ k: PH }, { k: PH });
    expect((merged as { k: string }).k).toBe(PH);
    expect(placeholders).toEqual(["k"]);
  });

  test("a placeholder inside an array preserves the local element (e.g. MCP args)", () => {
    // MCP args commonly carry a token, e.g. ["--token", "sk-real"]. The snapshot
    // side redacts the element, so apply must merge element-wise.
    const { merged, placeholders } = mergePreservingSecrets(
      { srv: { args: ["--token", "sk-real-local"] } },
      { srv: { args: ["--token", PH] } },
    );
    expect((merged as { srv: { args: string[] } }).srv.args).toEqual(["--token", "sk-real-local"]);
    expect(placeholders).toEqual([]);
  });

  test("non-secret array elements take the incoming value", () => {
    const { merged } = mergePreservingSecrets(
      { args: ["--old", "keep-me"] },
      { args: ["--new", "x"] },
    );
    expect((merged as { args: string[] }).args).toEqual(["--new", "x"]);
  });

  test("a prototype-polluting key from vault content is ignored", () => {
    const { merged } = mergePreservingSecrets({}, JSON.parse('{"__proto__":{"x":1},"ok":1}'));
    expect(({} as Record<string, unknown>).x).toBeUndefined(); // no pollution
    expect((merged as { ok: number }).ok).toBe(1);
  });
});
