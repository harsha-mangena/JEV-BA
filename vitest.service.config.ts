import { defineConfig } from 'vitest/config';

// PostgreSQL-backed service, concurrency and recovery tests. With QA_REQUIRE_SERVICE=1
// a missing DATABASE_URL fails the lane instead of skipping it.
export default defineConfig({ test: { include: ['tests/service/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } });
