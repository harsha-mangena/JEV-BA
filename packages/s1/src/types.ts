/**
 * Provider-neutral System One request/response model. This is *our* adapter
 * contract, not a vendor wire format: each provider adapter maps to and from
 * it, and must pass the same validation and evaluation suite.
 */
export interface ChoiceOption {
  key: string;
  label: string;
}

export interface ChoiceQuestion {
  id: string;
  kind: 'choice';
  /** Explicit instruction. Question ids are routing keys only and carry no meaning for the model. */
  prompt: string;
  options: ChoiceOption[];
}

export interface ScoreQuestion {
  id: string;
  kind: 'score';
  prompt: string;
}

export type Question = ChoiceQuestion | ScoreQuestion;

export interface S1Request {
  model: string;
  /** Untrusted page state, serialized separately from controller instructions. */
  context: string;
  questions: Question[];
}

export interface S1RawAnswer {
  /** Choice: probability per option key. Score: `{ score: p }`. */
  probabilities: Record<string, unknown>;
  selected?: unknown;
  confidence?: unknown;
}

export interface S1RawResponse {
  resolved_model?: unknown;
  answers: Record<string, S1RawAnswer | undefined>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SystemOneProvider {
  readonly id: string;
  ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse>;
}

export interface ValidAnswer {
  distribution: Record<string, number>;
  selected: string;
  top: { key: string; p: number };
  margin: number;
  confidence: number | null;
}
