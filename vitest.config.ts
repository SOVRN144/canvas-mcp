import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.env.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/services/**/*.test.{ts,js}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
