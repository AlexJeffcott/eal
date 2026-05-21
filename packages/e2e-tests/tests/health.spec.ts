import { test, expect } from '@playwright/test';

test.describe('day-one e2e baseline', () => {
  test('GET /public/health returns 200 { status: "ok" }', async ({ request }) => {
    const response = await request.get('/public/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok' });
  });

  test('the anonymous SPA shell renders, with the app auth-gated', async ({ page }) => {
    await page.goto('/');
    // Anonymous: the sign-in surface renders; the tasks panel is auth-gated.
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expect(page.locator('[data-tasks-panel]')).toHaveCount(0);
  });

  test('POST /api/v1/tasks is rejected without auth (401)', async ({ request }) => {
    const response = await request.post('/api/v1/tasks', { data: { title: 'x' } });
    expect(response.status()).toBe(401);
  });

  test('GET /api/v1/tasks is rejected without auth (401)', async ({ request }) => {
    const response = await request.get('/api/v1/tasks');
    expect(response.status()).toBe(401);
  });

  test('GET /api/v1/auth/me is rejected without auth (401)', async ({ request }) => {
    const response = await request.get('/api/v1/auth/me');
    expect(response.status()).toBe(401);
  });
});
