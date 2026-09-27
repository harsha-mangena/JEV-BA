import { z } from 'zod';

export const VisualReview = z
  .object({
    classification: z.enum(['intended_change', 'regression', 'rendering_noise', 'unsure']),
    rationale: z.string().max(500),
  })
  .strict();
export type VisualReview = z.infer<typeof VisualReview>;

/** Vision-capable System Two reviewer. Output is a review hint; it never approves or fails a baseline. */
export interface VisualReviewer {
  readonly id: string;
  readonly supportsImages: true;
  review(input: { baseline: Buffer; candidate: Buffer; diff: Buffer | null; checkpoint: string; scenario_id: string }): Promise<unknown>;
}

export async function reviewDiff(r: VisualReviewer | undefined, input: Parameters<VisualReviewer['review']>[0]): Promise<VisualReview | null> {
  if (!r?.supportsImages) return null;
  const parsed = VisualReview.safeParse(await r.review(input).catch(() => null));
  return parsed.success ? parsed.data : null;
}
