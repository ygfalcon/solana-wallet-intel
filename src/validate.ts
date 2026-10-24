/** Parse a query or tool argument that must be an integer in range. Empty means the default. */
export function parseBoundedInt(
  value: string | number | undefined | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value == null || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < min || value > max) return null;
    return value;
  }
  const trimmed = value.trim();
  // Reject huge digit strings before Number() so a multi-kilobyte query cannot burn CPU.
  if (trimmed.length > 10 || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}
