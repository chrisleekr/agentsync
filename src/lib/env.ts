/**
 * Trim a candidate string and treat blank values as absent. An exported but
 * empty env var is "" (a defined string), so `??` alone would short-circuit
 * the fallback chain on it; this collapses "" and whitespace-only to undefined
 * so resolution falls through to the next source. A non-blank value is
 * returned trimmed.
 */
export function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
