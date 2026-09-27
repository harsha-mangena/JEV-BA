import { defineConfig } from 'vitest/config';

// Live provider contract checks; skipped unless QA_S1_* credentials are set.
export default defineConfig({ test: { include: ['tests/live/**/*.test.ts'], testTimeout: 60_000 } });
