import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: existsSync('/usr/bin/chromium')
      ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] }
      : {},
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:3001/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: { HOSTLINE_DATA_DIR: '.data/browser-tests', NODE_ENV: 'test' },
  },
});
