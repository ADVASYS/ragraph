import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@main": resolve(__dirname, "electron/main"),
      "@shared": resolve(__dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globals: false,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["electron/main/core/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
