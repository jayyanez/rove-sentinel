import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/review-gate/__tests__/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
  },
});
