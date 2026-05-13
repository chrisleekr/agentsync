import { describe, expect, test } from "bun:test";
import {
  AGENTSYNC_HOME_PLACEHOLDER,
  denormalizeFromVault,
  denormalizeStringFromVault,
  normalizeForVault,
  normalizeStringForVault,
} from "../path-portability";

const ALPHA = "/home/alpha";
const BETA = "/home/beta";
const PLACE = AGENTSYNC_HOME_PLACEHOLDER;

describe("path-portability — string normalization", () => {
  test("rewrites literal home prefix followed by separator", () => {
    expect(normalizeStringForVault(`${ALPHA}/.claude/cache`, ALPHA)).toBe(`${PLACE}/.claude/cache`);
  });

  test("rewrites bare literal home equal to entire string", () => {
    expect(normalizeStringForVault(ALPHA, ALPHA)).toBe(PLACE);
  });

  test("rewrites ~ when followed by separator", () => {
    expect(normalizeStringForVault("~/projects/x", ALPHA)).toBe(`${PLACE}/projects/x`);
  });

  test("rewrites bare ~", () => {
    expect(normalizeStringForVault("~", ALPHA)).toBe(PLACE);
  });

  test("rewrites $HOME prefix", () => {
    expect(normalizeStringForVault("$HOME/foo", ALPHA)).toBe(`${PLACE}/foo`);
  });

  test("rewrites ${HOME} prefix", () => {
    expect(normalizeStringForVault("${HOME}/foo", ALPHA)).toBe(`${PLACE}/foo`);
  });

  test("rewrites home inside flag-style values", () => {
    expect(normalizeStringForVault(`--root=${ALPHA}/proj`, ALPHA)).toBe(`--root=${PLACE}/proj`);
  });

  test("leaves unrelated absolute paths alone", () => {
    expect(normalizeStringForVault("/etc/hosts", ALPHA)).toBe("/etc/hosts");
    expect(normalizeStringForVault("/opt/foo", ALPHA)).toBe("/opt/foo");
  });

  test("does not rewrite when home appears as substring of larger word", () => {
    expect(normalizeStringForVault(`${ALPHA}NOTME/foo`, ALPHA)).toBe(`${ALPHA}NOTME/foo`);
  });

  test("does not rewrite trailing-only matches without separator", () => {
    expect(normalizeStringForVault("prefix$HOMEsuffix", ALPHA)).toBe("prefix$HOMEsuffix");
    expect(normalizeStringForVault("prefix~suffix", ALPHA)).toBe("prefix~suffix");
  });

  test("rewrites multiple occurrences in one string", () => {
    expect(normalizeStringForVault(`from=${ALPHA}/a to=${ALPHA}/b`, ALPHA)).toBe(
      `from=${PLACE}/a to=${PLACE}/b`,
    );
  });

  test("empty inputs are no-ops", () => {
    expect(normalizeStringForVault("", ALPHA)).toBe("");
    expect(normalizeStringForVault("anything", "")).toBe("anything");
  });
});

describe("path-portability — string denormalization", () => {
  test("replaces every placeholder with the current home", () => {
    expect(denormalizeStringFromVault(`${PLACE}/proj`, BETA)).toBe(`${BETA}/proj`);
  });

  test("multiple placeholders in one string", () => {
    expect(denormalizeStringFromVault(`a=${PLACE}/x b=${PLACE}/y`, BETA)).toBe(
      `a=${BETA}/x b=${BETA}/y`,
    );
  });

  test("untouched if no placeholder present", () => {
    expect(denormalizeStringFromVault("/etc/hosts", BETA)).toBe("/etc/hosts");
  });

  test("throws on empty home — denormalize must always know HOME", () => {
    expect(() => denormalizeStringFromVault(`${PLACE}/x`, "")).toThrow();
    expect(() => denormalizeFromVault({ cwd: `${PLACE}/x` }, "")).toThrow();
  });

  test("home containing $ is not interpreted as a replacement pattern", () => {
    const dollarHome = "/home/$user";
    expect(denormalizeStringFromVault(`${PLACE}/proj`, dollarHome)).toBe(`${dollarHome}/proj`);
    expect(denormalizeStringFromVault(`${PLACE}/$$x`, "/home/u")).toBe("/home/u/$$x");
  });
});

describe("path-portability — JSON walker", () => {
  test("rewrites string values inside nested objects and arrays", () => {
    const input = {
      mcpServers: {
        filesystem: {
          command: "node",
          args: [`${ALPHA}/srv/index.js`, `--root=${ALPHA}/proj`],
          cwd: `${ALPHA}/.cursor`,
        },
      },
      misc: ["/etc/hosts", "not-a-path"],
    };
    const out = normalizeForVault(input, ALPHA) as typeof input;

    expect(out.mcpServers.filesystem.args[0]).toBe(`${PLACE}/srv/index.js`);
    expect(out.mcpServers.filesystem.args[1]).toBe(`--root=${PLACE}/proj`);
    expect(out.mcpServers.filesystem.cwd).toBe(`${PLACE}/.cursor`);
    expect(out.misc).toEqual(["/etc/hosts", "not-a-path"]);
  });

  test("non-string scalars pass through", () => {
    const input = { n: 1, b: true, z: null };
    const out = normalizeForVault(input, ALPHA);
    expect(out).toEqual(input);
  });

  test("returns the same reference when no string contains home", () => {
    const input = { a: "/etc/x", b: { c: ["one", "two"] } };
    const out = normalizeForVault(input, ALPHA);
    expect(out).toBe(input);
  });

  test("round-trip: normalize then denormalize is byte-identical for home-rooted paths", () => {
    const input = {
      filesystem: { cwd: `${ALPHA}/.cursor`, args: [`${ALPHA}/proj/file.ts`] },
    };
    const vaulted = normalizeForVault(input, ALPHA);
    const restored = denormalizeFromVault(vaulted, ALPHA);
    expect(restored).toEqual(input);
  });

  test("cross-machine round-trip rewrites alpha to beta paths", () => {
    const input = { cwd: `${ALPHA}/.config` };
    const vaulted = normalizeForVault(input, ALPHA);
    const restored = denormalizeFromVault(vaulted, BETA) as typeof input;
    expect(restored.cwd).toBe(`${BETA}/.config`);
  });

  test("empty home returns the input unchanged for normalize", () => {
    const input = { cwd: `${ALPHA}/x` };
    expect(normalizeForVault(input, "")).toBe(input);
  });

  test("home with trailing separator is handled the same as without", () => {
    expect(normalizeStringForVault(`${ALPHA}/proj`, `${ALPHA}/`)).toBe(`${PLACE}/proj`);
    expect(normalizeStringForVault(ALPHA, `${ALPHA}/`)).toBe(PLACE);
  });

  test("normalize is idempotent when input already contains the placeholder", () => {
    const input = { cwd: `${PLACE}/x` };
    const once = normalizeForVault(input, ALPHA);
    const twice = normalizeForVault(once, ALPHA);
    expect(twice).toEqual(once);
  });
});
