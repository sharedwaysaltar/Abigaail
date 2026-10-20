// Seeded randomness, so a run (and every test) is reproducible with --seed.

export type Rng = () => number;

/** mulberry32: small, fast, good enough for traffic shapes. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Poisson-distributed count with mean `lambda` (Knuth; normal approximation above 30). */
export function poisson(r: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    const u = Math.max(r(), Number.EPSILON);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = r();
  while (p > limit) {
    k++;
    p *= r();
  }
  return k;
}

export const between = (r: Rng, [min, max]: readonly [number, number]): number => min + r() * (max - min);

export function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)]!;
}

/** A random v4 UUID drawn from `r` (event ids for seeded history). */
export function uuid(r: Rng): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Math.floor(r() * 4) & 3) | 8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
