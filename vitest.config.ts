import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { LOG_LEVEL: "warn" },
    testTimeout: 60_000,
  },
});
