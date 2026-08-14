import { applyEdits, modify, type ParseError, parse, visit } from "jsonc-parser";
import { denormalizeFromVault, normalizeForVault } from "../../core/path-portability";
import {
  type RedactionResult,
  redactSecretLiterals,
  type SecretPolicy,
} from "../../core/sanitizer";
import { mergePreservingSecrets } from "../../core/secret-merge";

const FORMATTING = { insertSpaces: true, tabSize: 2 } as const;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeKeys(value: unknown, label: string, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSafeKeys(entry, label, `${path}[${index}]`);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (UNSAFE_KEYS.has(key)) throw new Error(`${label} contains unsafe key '${field}'`);
    assertSafeKeys(child, label, field);
  }
}

function assertSafeJsoncSyntax(raw: string, label: string): void {
  visit(
    raw,
    {
      onObjectProperty(property, _offset, _length, _line, _character, pathSupplier) {
        if (!UNSAFE_KEYS.has(property)) return;
        const path = [...pathSupplier(), property].join(".");
        throw new Error(`${label} contains unsafe key '${path}'`);
      },
    },
    { allowTrailingComma: true },
  );
}

/** Parse a complete JSONC object. Empty files have OpenCode's effective `{}` value. */
export function parseOpenCodeJsonc(raw: string, label: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  assertSafeJsoncSyntax(raw, label);
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    throw new Error(`${label} must contain a valid JSONC object`);
  }
  assertSafeKeys(parsed, label);
  return parsed;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function replaceValue(raw: string, path: (string | number)[], value: unknown): string {
  return applyEdits(raw, modify(raw, path, value, { formattingOptions: FORMATTING }));
}

function patchChangedLeaves(
  raw: string,
  before: unknown,
  after: unknown,
  path: (string | number)[] = [],
): string {
  if (sameValue(before, after)) return raw;
  if (isPlainObject(before) && isPlainObject(after)) {
    let patched = raw;
    for (const key of Object.keys(after)) {
      patched = patchChangedLeaves(patched, before[key], after[key], [...path, key]);
    }
    return patched;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    let patched = raw;
    for (let index = 0; index < after.length; index++) {
      patched = patchChangedLeaves(patched, before[index], after[index], [...path, index]);
    }
    return patched;
  }
  return replaceValue(raw, path, after);
}

/** Normalize paths and redact secret literals without discarding JSONC comments. */
export function sanitizeOpenCodeJsonc(
  raw: string,
  label: string,
  home: string,
  policy: SecretPolicy,
): RedactionResult<string> {
  const parsed = parseOpenCodeJsonc(raw, label);
  const normalized = normalizeForVault(parsed, home);
  const redacted = redactSecretLiterals(normalized, label, policy);
  const base = raw.trim() ? raw : "{}\n";
  return {
    value: patchChangedLeaves(base, parsed, redacted.value),
    warnings: redacted.warnings,
  };
}

function patchIncomingOverlay(
  raw: string,
  existing: unknown,
  incoming: unknown,
  merged: unknown,
  path: (string | number)[] = [],
): string {
  if (isPlainObject(existing) && isPlainObject(incoming) && isPlainObject(merged)) {
    let patched = raw;
    for (const key of Object.keys(incoming)) {
      patched = patchIncomingOverlay(patched, existing[key], incoming[key], merged[key], [
        ...path,
        key,
      ]);
    }
    return patched;
  }
  if (Array.isArray(existing) && Array.isArray(incoming) && Array.isArray(merged)) {
    let patched = raw;
    for (let index = 0; index < merged.length; index++) {
      patched = patchIncomingOverlay(patched, existing[index], incoming[index], merged[index], [
        ...path,
        index,
      ]);
    }
    for (let index = existing.length - 1; index >= merged.length; index--) {
      patched = replaceValue(patched, [...path, index], undefined);
    }
    return patched;
  }
  if (sameValue(existing, merged)) return raw;
  return replaceValue(raw, path, merged);
}

/** Add a vault JSONC layer onto a local layer without replacing local-only keys or real secrets. */
export function mergeOpenCodeJsonc(
  existingRaw: string | null,
  incomingRaw: string,
  label: string,
  home: string,
): string {
  const incomingParsed = parseOpenCodeJsonc(incomingRaw, `${label} vault artifact`);
  const incoming = denormalizeFromVault(incomingParsed, home);
  const restored = patchChangedLeaves(
    incomingRaw.trim() ? incomingRaw : "{}\n",
    incomingParsed,
    incoming,
  );
  if (existingRaw === null) return restored;

  const existingBase = existingRaw.trim() ? existingRaw : "{}\n";
  const existing = parseOpenCodeJsonc(existingBase, `Local ${label}`);
  const { merged } = mergePreservingSecrets(existing, incoming);
  return patchIncomingOverlay(existingBase, existing, incoming, merged);
}
