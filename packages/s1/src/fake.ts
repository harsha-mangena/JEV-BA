import type { ChoiceQuestion, S1RawResponse, S1Request, SystemOneProvider } from './types.ts';

/** Returns pre-scripted responses in order. For contract tests and replay. */
export class ScriptedProvider implements SystemOneProvider {
  readonly id = 'scripted';
  readonly requests: S1Request[] = [];
  constructor(private readonly responses: Array<S1RawResponse | ((req: S1Request) => S1RawResponse)>) {}
  async ask(req: S1Request): Promise<S1RawResponse> {
    this.requests.push(req);
    const next = this.responses.shift();
    if (!next) throw new Error('ScriptedProvider exhausted');
    return typeof next === 'function' ? next(req) : next;
  }
}

/**
 * Deterministic offline stand-in for a System One model: scores options by
 * keyword overlap with a per-head preference list. It exists to exercise the
 * controller end to end without network access. It is *not* a model and its
 * scores say nothing about any real provider's calibration.
 */
export class KeywordProvider implements SystemOneProvider {
  readonly id = 'keyword-offline';
  readonly requests: S1Request[] = [];
  constructor(private readonly prefer: (req: S1Request, q: ChoiceQuestion) => string[]) {}

  async ask(req: S1Request): Promise<S1RawResponse> {
    this.requests.push(req);
    const answers: S1RawResponse['answers'] = {};
    for (const q of req.questions) {
      if (q.kind !== 'choice') {
        answers[q.id] = { probabilities: { score: 0.5 } };
        continue;
      }
      const wants = this.prefer(req, q).map((w) => w.toLowerCase());
      const weights = q.options.map((o) => {
        const label = `${o.key} ${o.label}`.toLowerCase();
        const idx = wants.findIndex((w) => label.includes(w));
        return idx === -1 ? 0.05 : 10 / (idx + 1);
      });
      const total = weights.reduce((a, b) => a + b, 0);
      answers[q.id] = { probabilities: Object.fromEntries(q.options.map((o, i) => [o.key, weights[i]! / total])) };
    }
    return { resolved_model: 'keyword-offline', answers };
  }
}
