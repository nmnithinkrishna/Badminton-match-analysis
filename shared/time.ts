// Zod-free helpers so the browser bundle stays small.

/** "1:02:03" | "02:03" -> seconds. Returns NaN for bad input. */
export function toSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
