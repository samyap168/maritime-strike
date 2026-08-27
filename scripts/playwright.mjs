/**
 * Resolve Playwright from wherever it happens to be installed.
 * These tests are a development aid, not a dependency of the game — the game
 * itself has none.
 */
export async function loadChromium() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try { return (await import(spec)).chromium; } catch { /* try the next */ }
  }
  throw new Error('Playwright not found. Install it with:  npm i -D playwright && npx playwright install chromium');
}

export const LAUNCH = {
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
};

export const BASE = process.env.BASE_URL || 'http://localhost:8080';
