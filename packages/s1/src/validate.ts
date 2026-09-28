import type { S1RawAnswer, S1RawResponse, S1Request, ValidAnswer } from './types.ts';

/** Documented numerical tolerance for a distribution's sum. */
export const SUM_TOLERANCE = 1e-3;
/** Probabilities within this distance are a genuine tie; the uncertainty gate handles them. */
export const TIE_EPSILON = 1e-9;

export interface ValidationOutcome {
  answers: Record<string, ValidAnswer>;
  /** Head id → problem. A malformed head is never usable for execution. */
  invalid: Record<string, string>;
  resolvedModel: string | null;
}

function validateChoice(raw: S1RawAnswer | undefined, keys: string[]): ValidAnswer | string {
  if (!raw || typeof raw !== 'object' || !raw.probabilities || typeof raw.probabilities !== 'object') return 'missing answer';
  const probs = raw.probabilities;
  const got = Object.keys(probs);
  const unknown = got.filter((k) => !keys.includes(k));
  if (unknown.length) return `unknown choice key(s): ${unknown.join(', ')}`;
  const missing = keys.filter((k) => !(k in probs));
  if (missing.length) return `missing probability for: ${missing.join(', ')}`;
  const distribution: Record<string, number> = {};
  for (const k of keys) {
    const p = probs[k];
    if (typeof p !== 'number' || !Number.isFinite(p)) return `non-finite probability for ${k}`;
    if (p < 0 || p > 1) return `probability out of range for ${k}: ${p}`;
    distribution[k] = p;
  }
  const sum = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `probabilities sum to ${sum}, outside tolerance ${SUM_TOLERANCE}`;
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const [topKey, topP] = sorted[0]!;
  const second = sorted[1]?.[1] ?? 0;
  let selected = topKey;
  if (raw.selected !== undefined) {
    if (typeof raw.selected !== 'string' || !keys.includes(raw.selected)) return `selected ${JSON.stringify(raw.selected)} is not a valid option`;
    if (distribution[raw.selected]! < topP - TIE_EPSILON) return `selected ${raw.selected} is not a maximal-probability option`;
    selected = raw.selected;
  }
  let confidence: number | null = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) return 'invalid confidence';
    confidence = raw.confidence;
  }
  return { distribution, selected, top: { key: selected, p: distribution[selected]! }, margin: distribution[selected]! - (selected === topKey ? second : topP), confidence };
}

/**
 * Validate every head of a provider response against the request. Nothing is
 * normalized or repaired: a malformed head is reported and unusable. Callers
 * log unused malformed heads as provider anomalies and must never execute on
 * a malformed selected head.
 */
export function validateResponse(req: S1Request, raw: S1RawResponse): ValidationOutcome {
  const answers: Record<string, ValidAnswer> = {};
  const invalid: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || !raw.answers || typeof raw.answers !== 'object') {
    for (const q of req.questions) invalid[q.id] = 'response has no answers object';
    return { answers, invalid, resolvedModel: null };
  }
  for (const extra of Object.keys(raw.answers)) {
    if (!req.questions.some((q) => q.id === extra)) invalid[extra] = 'answer for a question that was not asked';
  }
  for (const q of req.questions) {
    const keys = q.kind === 'choice' ? q.options.map((o) => o.key) : ['true'];
    const adapterError = raw.answers[q.id]?.error;
    if (adapterError) {
      invalid[q.id] = adapterError;
      continue;
    }
    if (q.kind === 'noul') {
      const p = raw.answers[q.id]?.probabilities?.true;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) invalid[q.id] = 'invalid noul probability';
      else answers[q.id] = { distribution: { true: p, false: 1 - p }, selected: p >= 0.5 ? 'true' : 'false', top: { key: p >= 0.5 ? 'true' : 'false', p: Math.max(p, 1 - p) }, margin: Math.abs(2 * p - 1), confidence: null };
      continue;
    }
    if (new Set(keys).size !== keys.length) {
      invalid[q.id] = 'request has duplicate option keys';
      continue;
    }
    const r = validateChoice(raw.answers[q.id], keys);
    if (typeof r === 'string') invalid[q.id] = r;
    else answers[q.id] = r;
  }
  return { answers, invalid, resolvedModel: typeof raw.resolved_model === 'string' ? raw.resolved_model : null };
}
