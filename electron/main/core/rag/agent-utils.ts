/**
 * Pure helpers used by the agent that are extracted into a dependency-free
 * module so they can be unit-tested without pulling in the AI SDK, electron,
 * or the rest of the tooling graph.
 */

/**
 * Stable JSON.stringify with sorted object keys — used to fingerprint
 * tool calls so the loop detector can recognise "call X with the same
 * arguments again" regardless of key insertion order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
