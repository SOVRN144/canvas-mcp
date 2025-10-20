import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [],
    hookTimeout: 20000,
    testTimeout: 20000
  }
});
