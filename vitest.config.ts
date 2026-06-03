import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: [
      "tests/embedding.test.ts",
      "tests/benchmark.ts",
      "tests/stress.ts",
      "node_modules",
    ],
  },
})
