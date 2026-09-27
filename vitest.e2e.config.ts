import { defineConfig } from 'vitest/config';

// Browser-backed end-to-end tests. Each file starts its own fixture app on an
// ephemeral port, so files may run in parallel.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
