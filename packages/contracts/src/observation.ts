import { z } from 'zod';

export const Operation = z.enum(['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'WAIT', 'DONE', 'BLOCKED']);
export type Operation = z.infer<typeof Operation>;
/** Operations that act on an observed target node. */
export const TARGETED_OPERATIONS = ['CLICK', 'TYPE', 'SELECT'] as const satisfies readonly Operation[];
export type TargetedOperation = (typeof TARGETED_OPERATIONS)[number];
export const isTargeted = (op: Operation): op is TargetedOperation => (TARGETED_OPERATIONS as readonly string[]).includes(op);

export const ObservedElement = z.object({
  /** Ephemeral id, valid only within the observation's document. */
  node_id: z.string(),
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  input_type: z.string().optional(),
  /** Redacted for password/secret-like fields. */
  value: z.string().optional(),
  section: z.string().optional(),
  form: z.string().optional(),
  checked: z.boolean().optional(),
  expanded: z.boolean().optional(),
  visible: z.boolean(),
  enabled: z.boolean(),
  editable: z.boolean(),
  in_viewport: z.boolean(),
  supported_operations: z.array(Operation),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  options: z.array(z.string()).optional(),
});
export type ObservedElement = z.infer<typeof ObservedElement>;

export const ObservationCoverage = z.object({
  candidates_total: z.number().int().nonnegative(),
  candidates_included: z.number().int().nonnegative(),
  truncated: z.boolean(),
  unsupported_frames: z.number().int().nonnegative(),
  /** Shadow roots whose content was not extracted (closed roots cannot be seen and are not counted). */
  shadow_roots_skipped: z.number().int().nonnegative(),
  /** Open shadow roots whose controls were extracted. */
  shadow_roots_traversed: z.number().int().nonnegative().optional(),
  extraction_errors: z.array(z.string()),
});

export const ActionOutcomeSummary = z.object({
  operation: Operation,
  target_name: z.string().optional(),
  result: z.enum(['effect_observed', 'no_effect', 'failed', 'denied', 'unknown']),
});

export const Observation = z.object({
  observation_id: z.string(),
  document_id: z.string(),
  page_id: z.string(),
  timestamp: z.string().datetime(),
  route: z.string(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  current_milestone: z.string().optional(),
  milestones_completed: z.array(z.string()),
  recent_outcomes: z.array(ActionOutcomeSummary).max(5),
  /** Eligible action targets. */
  candidates: z.array(ObservedElement),
  /** Diagnostic-only elements: disabled controls, alerts/errors, hidden required targets. */
  diagnostics: z.array(ObservedElement),
  /** Visible status/alert text, serialized as untrusted page data. */
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
  coverage: ObservationCoverage,
});
export type Observation = z.infer<typeof Observation>;
