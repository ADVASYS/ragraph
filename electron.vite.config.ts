import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": resolve(__dirname, "electron/main"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "electron/main/index.ts"),
        output: {
          format: "es",
          entryFileNames: "[name].mjs",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "electron/preload/index.ts"),
        output: {
          format: "es",
          entryFileNames: "[name].mjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/index.html"),
      },
    },
    server: {
      port: 5173,
    },
  },
});
