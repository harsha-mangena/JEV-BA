import { defineConfig } from 'vitest/config';

// Browser-backed end-to-end and service tests. Each file starts its own fixture
// app on an ephemeral port (and, for service tests, its own Postgres schema).
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts', 'tests/service/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
