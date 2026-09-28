import { defineConfig } from 'vitest/config';

// Independent audit probes (F01–F08) kept as mandatory regression protection.
export default defineConfig({ test: { include: ['tests/audit/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } });
