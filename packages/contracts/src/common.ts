import { z } from 'zod';

/** Identifier used for scenarios, fixtures, milestones and requirements. */
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'must be lowercase letters, digits, "_", "." or "-"');

export const RequirementId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'must look like AREA-01');

export const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character lowercase commit SHA');

export const HttpsUrl = z
  .string()
  .url()
  .refine((u) => {
    const { protocol } = new URL(u);
    return protocol === 'https:' || protocol === 'http:';
  }, 'must be an http(s) URL');

/**
 * A reference into fixture data or secrets, e.g. `fixture.customer_id` or
 * `secret.customer_password`. Secrets are resolved only by the executor at
 * execution time and are never serialized into evidence.
 */
export const ValueRef = z.string().regex(/^(fixture|secret)\.[a-z0-9_]+$/, 'must be fixture.<field> or secret.<field>');
export type ValueRef = z.infer<typeof ValueRef>;

export function parseRef(ref: string): { scope: 'fixture' | 'secret'; field: string } {
  const [scope, field] = ref.split('.', 2);
  if ((scope !== 'fixture' && scope !== 'secret') || !field) throw new Error(`invalid value reference: ${ref}`);
  return { scope, field };
}

export interface ValidationIssue {
  path: string;
  message: string;
}
