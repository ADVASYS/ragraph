import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Smoke test: the app launches, loads the renderer, and shows the onboarding
 * or main layout without a crash. Extended flows require a configured provider
 * and are gated behind the `RAGRAPH_E2E_FULL` environment variable.
 */
test("app launches and renders main window", async () => {
  const electronApp = await electron.launch({
    args: [resolve(__dirname, "..", "..", "out", "main", "index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      RAGRAPH_HEADLESS: "1",
    },
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const title = await window.title();
  expect(title.toLowerCase()).toContain("ragraph");

  await electronApp.close();
});
