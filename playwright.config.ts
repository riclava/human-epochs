import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  globalSetup: './tests/fixtures/browser-database.ts',
  use: {
    baseURL: 'http://127.0.0.1:5317',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: 'npm run dev:web -- --port 5317', url: 'http://127.0.0.1:5317',
    env: { PORT: '3307' },
  },
})
