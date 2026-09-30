import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { bootstrapSchema, type InboxItem } from '@hostline/contracts';

async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter demo', exact: true }).click();
  await expect(page.locator('.topbar-location')).toBeVisible();
}
async function say(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Your message as the guest' });
  await expect(input).toBeEnabled();
  await input.fill(text);
  await page.getByRole('button', { name: 'Send guest message' }).click();
  await expect(input).toBeEnabled();
}

test('guest request, staff booking evidence and guest communication remain separate', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await enter(page);
  await page.getByRole('link', { name: 'Call simulator' }).click();
  await page.getByRole('button', { name: 'Start practice call' }).click();
  await say(page, 'I would like a table for four tomorrow at 7 PM');
  const guest = `Browser Guest ${Date.now()}`;
  await say(page, guest);
  await say(page, '+12125550142');
  await expect(page.getByRole('button', { name: 'Confirm request', exact: true })).toBeVisible();
  await expect(page.locator('.proposal-card')).toContainText('your table is not confirmed');
  await page.getByRole('button', { name: 'Confirm request', exact: true }).click();
  await expect(page.getByText('Request saved for staff review', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open guest request' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(guest);
  await dialog.getByRole('button', { name: 'Take ownership', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start arranging reservation' }).click();
  await dialog.getByRole('button', { name: 'Record a booking', exact: true }).click();
  await dialog
    .getByLabel('Evidence from your booking system')
    .fill('Synthetic manual book reference DEMO-1042, checked by test staff.');
  await dialog.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Close request', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Record guest communication', exact: true }).click();
  await dialog
    .getByLabel('How did you contact the guest?')
    .fill('Synthetic caller reached and confirmation communicated.');
  await dialog.getByRole('button', { name: 'Save update', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close request', exact: true }).click();
  await expect(dialog).toContainText('Closed');
  await expect(dialog).toContainText('DEMO-1042');
  expect(pageErrors).toEqual([]);
});

test('restaurant settings persist and remain isolated when switching demo workspace', async ({
  page,
}) => {
  await enter(page);
  await page.getByRole('link', { name: 'Knowledge & settings' }).click();
  const address = page.getByLabel('Street address', { exact: true });
  await expect(address).toBeVisible();
  const prior = await address.inputValue();
  const modified = '42 Synthetic Browser Avenue, Brooklyn, NY';
  await address.fill(modified);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('Street address', { exact: true })).toHaveValue(modified);
  await page.getByLabel('Switch demo restaurant').selectOption('juniper');
  await expect(page.getByLabel('Street address', { exact: true })).not.toHaveValue(modified);
  await page.getByLabel('Switch demo restaurant').selectOption('harbor');
  await expect(page.getByLabel('Street address', { exact: true })).toHaveValue(modified);
  await page.getByLabel('Street address', { exact: true }).fill(prior);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
});

test('mobile navigation and unsupported vendor states work without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'OpenTable', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resy', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enter demo', exact: true })).toBeVisible();
});

test('requests beyond the first page remain reachable from the inbox', async ({ page }) => {
  let remaining: InboxItem | undefined;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const data = bootstrapSchema.parse(await response.json());
    const sample = data.inbox[0];
    if (!sample) throw new Error('Expected synthetic inbox fixture.');
    const pageItems = Array.from({ length: 200 }, (_, index) => ({
      ...sample,
      id: randomUUID(),
      name: `Paged Example ${index}`,
      state: 'PENDING_STAFF_REVIEW' as const,
    }));
    remaining = {
      ...sample,
      id: randomUUID(),
      name: 'Guest Beyond First Page',
      state: 'PENDING_STAFF_REVIEW',
    };
    await route.fulfill({ response, json: { ...data, inbox: pageItems } });
  });
  await page.route('**/api/inbox?*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('offset')).toBe('200');
    await route.fulfill({ json: [remaining] });
  });
  await enter(page);
  await page.getByRole('link', { name: /Guest requests/ }).click();
  await page.getByRole('button', { name: /Load more/ }).click();
  await page
    .getByRole('button', { name: /Guest Beyond First Page/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText('Guest Beyond First Page');
});
