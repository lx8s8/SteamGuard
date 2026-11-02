import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 2,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1180, height: 820 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:1420",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command:
        "npm run build && npm run preview -- --host 127.0.0.1 --port 1422",
      url: "http://127.0.0.1:1422",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
