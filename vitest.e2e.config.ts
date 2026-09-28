import { defineConfig } from 'vitest/config';

// Browser-backed end-to-end tests against the controlled fixture application.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
