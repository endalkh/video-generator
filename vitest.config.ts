import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 720p keeps the ffmpeg renders in the tests fast (the app defaults to 4k).
    env: { LOG_LEVEL: "warn", VIDEO_RESOLUTION: "720p" },
    testTimeout: 60_000,
  },
});
