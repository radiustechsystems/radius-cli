import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.RADIUS_E2E ? [] : ['test/e2e/**'],
  },
});
