import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: process.env.HYEB_COMBINED_GATE === "1" ? 2 : undefined,
  },
});
