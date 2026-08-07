import { defineConfig, devices } from "@playwright/test"

const PORT = 3100
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL
const BASE_URL = externalBaseUrl ?? `http://127.0.0.1:${PORT}`

/**
 * Smoke tests run against a production build: `pnpm build` first, then
 * `pnpm test:e2e`.
 *
 * The environment below is deliberately fake. The smoke test never signs in,
 * so nothing reaches the database — which is what keeps this runnable without
 * a Neon project. Testing a real sign-in belongs against a preview URL with
 * real environment, not here.
 *
 * PLAYWRIGHT_BASE_URL, when set, points the same spec at an already-deployed
 * URL — a Vercel preview, say — instead of starting a local server. This is
 * what the PR pipeline's smoke gate uses; nothing in the spec itself changes.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `pnpm exec next start --port ${PORT}`,
        url: `${BASE_URL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          // Auth.js infers the host on Vercel, but rejects an arbitrary one when
          // self-hosted — including 127.0.0.1 here.
          AUTH_TRUST_HOST: "true",
          AUTH_SECRET: "smoke-test-secret-that-is-long-enough-to-pass",
          DATABASE_URL: "postgresql://smoke:smoke@127.0.0.1:1/smoke",
          WERFT_USER_EMAIL: "smoke@example.test",
          WERFT_PASSWORD_HASH: "scrypt$65536$8$1$00$00",
        },
      },
})
