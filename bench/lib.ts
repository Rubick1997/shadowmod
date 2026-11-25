export interface BenchItem {
  id: string;
  source: string;
  text: string;
  /** 1 = should be flagged for this question, 0 = should not. Missing = not labelled. */
  labels: Record<string, 0 | 1>;
  /** e.g. hard-negative category */
  category?: string;
  meta?: Record<string, unknown>;
}

/** mulberry32: small seeded PRNG so samples and synthetic data are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const pick = <T>(xs: T[], r: () => number): T => xs[Math.floor(r() * xs.length)]!;
