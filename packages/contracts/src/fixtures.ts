import { z } from 'zod';
import { Slug } from './common.ts';

/**
 * Declares which fixtures exist and which fields they expose, so scenario
 * references can be validated statically before any run is attempted.
 */
export const FixtureCatalog = z
  .object({
    schema_version: z.literal(1),
    fixtures: z.record(
      Slug,
      z
        .object({
          description: z.string(),
          role: z.string().min(1),
          fields: z.array(z.string().regex(/^[a-z0-9_]+$/)),
          secrets: z.array(z.string().regex(/^[a-z0-9_]+$/)).default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type FixtureCatalog = z.output<typeof FixtureCatalog>;

/** Response of the fixture service when provisioning a test-owned fixture. */
export const ProvisionedFixture = z.object({
  fixture_id: z.string().min(1),
  name: Slug,
  data: z.record(z.union([z.string(), z.number(), z.boolean()])),
  secrets: z.record(z.string()).default({}),
  auth: z
    .object({ cookies: z.array(z.object({ name: z.string(), value: z.string() })) })
    .optional(),
});
export type ProvisionedFixture = z.output<typeof ProvisionedFixture>;
