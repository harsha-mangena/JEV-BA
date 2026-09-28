import { defineConfig } from 'vitest/config';

// Generated-code sandbox containment and evidence-sanitization tests. The lane fails
// (never skips) when the sandbox is unavailable on a runner that requires it.
export default defineConfig({ test: { include: ['tests/isolation/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000, passWithNoTests: false } });
