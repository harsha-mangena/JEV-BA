/** Numerically careful helpers; no external statistics dependency. */

function logGamma(x: number): number {
  // Lanczos approximation (g=7, n=9).
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const logChoose = (n: number, k: number) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/** P(X ≥ k) for X ~ Binomial(n, p). */
export function binomialUpperTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, s);
}

/**
 * One-sided exact (Clopper–Pearson) lower confidence bound on a proportion
 * with `k` successes out of `n`: the smallest p with P(X ≥ k | p) ≥ α.
 * With k = n this is α^(1/n) (plan §9.2).
 */
export function clopperPearsonLower(k: number, n: number, confidence = 0.95): number {
  if (n === 0 || k === 0) return 0;
  const alpha = 1 - confidence;
  if (k === n) return alpha ** (1 / n);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomialUpperTail(n, k, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Error-free accepted actions needed for a lower bound ≥ target (e.g. 299 for 99%, 2995 for 99.9%). */
export function zeroErrorSampleSize(target: number, confidence = 0.95): number {
  return Math.ceil(Math.log(1 - confidence) / Math.log(target));
}

/** Probability that every one of `steps` independent actions is correct — an illustration, not a measurement. */
export const journeySuccess = (stepPrecision: number, steps: number) => stepPrecision ** steps;

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const logit = (p: number) => {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
};

/** Deterministic PRNG (mulberry32) for reproducible splits and bootstraps. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo);
}
