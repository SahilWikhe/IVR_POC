import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  phoneOperationsSchema,
  sessionSchema,
  type InboxItem,
  type PhoneCallDetail,
  type PhoneCallSummary,
  type PhoneOperations,
  type Role,
} from '@hostline/contracts';

const instant = '2026-09-30T16:00:00.000Z';

function phoneCall(overrides: Partial<PhoneCallSummary> = {}): PhoneCallSummary {
  return {
    id: randomUUID(),
    version: 1,
    state: 'NEEDS_RECONCILIATION',
    controlKind: 'readback',
    controlState: 'UNKNOWN',
    createdAt: instant,
    updatedAt: instant,
    endedAt: null,
    outcome: 'Phone update outcome is uncertain.',
    capacityHeld: true,
    requiresReconciliation: true,
    ...overrides,
  };
}

function operations(calls: PhoneCallSummary[], hasMore = false): PhoneOperations {
  return {
    policy: {
      version: 1,
      voiceEnabled: true,
      requestsEnabled: true,
      transfersEnabled: false,
      updatedAt: instant,
    },
    configured: {
      voiceEnabled: false,
      requestsEnabled: false,
      transfersEnabled: false,
      reconciliationAvailable: false,
    },
    calls,
    hasMore,
  };
}

async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter demo', exact: true }).click();
  await expect(page.locator('.topbar-location')).toBeVisible();
  await page.getByRole('link', { name: 'Phone operations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent phone calls' })).toBeVisible();
}

async function mockRole(page: Page, role: Role) {
  await page.route('**/api/auth/demo', async (route) => {
    const response = await route.fetch();
    const session = sessionSchema.parse(await response.json());
    if (!session.user) throw new Error('Expected synthetic signed-in user.');
    await route.fulfill({ response, json: { ...session, user: { ...session.user, role } } });
  });
}

test('phone policy persists without activating an unconfigured phone line', async ({ page }) => {
  await enter(page);
  const response = await page.request.get('/api/phone/operations?offset=0&limit=50');
  expect(response.ok()).toBe(true);
  const original = phoneOperationsSchema.parse(await response.json());
  expect(original.configured.voiceEnabled).toBe(false);
  const changed = !original.policy.voiceEnabled;
  try {
    const calls = page.getByRole('checkbox', { name: 'Allow new calls', exact: true });
    await calls.setChecked(changed);
    await page.getByRole('button', { name: 'Save phone policy', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Calling stays unavailable');
    await expect(page.locator('.phone-policy-card')).toContainText('Not configured');
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Allow new calls', exact: true })).toBeChecked({
      checked: changed,
    });
    await expect(page.locator('.phone-policy-card')).toContainText('Not configured');
    await expect(page.locator('.phone-policy-card')).toContainText(
      'invalidates pending caller confirmations',
    );
  } finally {
    const currentResponse = await page.request.get('/api/phone/operations?offset=0&limit=50');
    const current = phoneOperationsSchema.parse(await currentResponse.json());
    const sessionResponse = await page.request.get('/api/session');
    const session = sessionSchema.parse(await sessionResponse.json());
    expect(session.csrfToken).toBeTruthy();
    const restored = await page.request.put('/api/phone/policy', {
      headers: { Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': session.csrfToken ?? '' },
      data: {
        expectedVersion: current.policy.version,
        policy: {
          voiceEnabled: original.policy.voiceEnabled,
          requestsEnabled: original.policy.requestsEnabled,
          transfersEnabled: original.policy.transfersEnabled,
        },
      },
    });
    expect(restored.ok()).toBe(true);
  }
});

test('older phone calls remain reachable and uncertain capacity stays held until provider evidence', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const firstPage = Array.from({ length: 50 }, (_, index) =>
    phoneCall({ outcome: `Synthetic call ${index}` }),
  );
  let older = phoneCall({ createdAt: '2026-09-29T16:00:00.000Z', outcome: 'Older uncertain call' });
  let checks = 0;
  await page.route('**/api/phone/operations?*', async (route) => {
    const offset = new URL(route.request().url()).searchParams.get('offset');
    const fixture = operations(offset === '50' ? [older] : firstPage, offset !== '50');
    fixture.configured.reconciliationAvailable = true;
    await route.fulfill({ json: fixture });
  });
  await page.route(`**/api/phone/calls/${older.id}`, async (route) => {
    const detail: PhoneCallDetail = {
      call: older,
      context: {
        callId: older.id,
        controlId: randomUUID(),
        reason: 'requested_staff',
        summary: '<script>window.phoneFixtureExecuted = true</script> Caller asks for staff.',
        createdAt: instant,
        source: 'AI_UNTRUSTED',
      },
      pendingProposal: {
        id: randomUUID(),
        kind: 'message',
        readback: 'Please ask staff to call Synthetic Guest at +12125550142 about a group dinner.',
        expiresAt: '2026-10-01T16:00:00.000Z',
        reservation: null,
        message: {
          name: 'Synthetic Guest',
          callbackNumber: '+12125550142',
          message: 'Please call about a group dinner.',
        },
      },
      savedItem: null,
    };
    await route.fulfill({ json: detail });
  });
  await page.route(`**/api/phone/calls/${older.id}/reconcile`, async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({ expectedVersion: older.version });
    checks += 1;
    older =
      checks === 1
        ? { ...older, version: 2 }
        : {
            ...older,
            version: 3,
            state: 'ENDED',
            endedAt: instant,
            capacityHeld: false,
            requiresReconciliation: false,
            controlState: 'COMPLETED',
            outcome: 'Provider confirmed the call ended.',
          };
    await route.fulfill({
      json: {
        call: older,
        result: checks === 1 ? 'held' : 'ended',
        message:
          checks === 1
            ? 'Provider reports an active call. Capacity remains held.'
            : 'Provider confirmed the call ended. Capacity is released.',
      },
    });
  });
  await enter(page);
  await page.getByRole('button', { name: 'Load more phone calls', exact: true }).click();
  const row = page.locator('.phone-call-row').filter({ hasText: 'Older uncertain call' });
  await row.getByRole('button', { name: /View phone call/ }).click();
  const detail = page.getByRole('region', { name: 'Phone call details' });
  await expect(detail.getByRole('heading', { name: 'AI-prepared context' })).toBeVisible();
  await expect(detail).toContainText('Untrusted context');
  await expect(detail).toContainText('<script>window.phoneFixtureExecuted = true</script>');
  await expect(detail.getByRole('heading', { name: 'Unconfirmed message' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Open guest request', exact: true })).toHaveCount(
    0,
  );
  await detail.getByRole('button', { name: 'Check provider status', exact: true }).click();
  await expect(detail.getByRole('status')).toContainText('Capacity remains held');
  await expect(detail).toContainText('Phone capacity remains held');
  await detail.getByRole('button', { name: 'Check provider status', exact: true }).click();
  await expect(detail.getByRole('status')).toContainText('Capacity is released');
  await expect(
    detail.getByRole('button', { name: 'Check provider status', exact: true }),
  ).toBeDisabled();
  await expect(detail.getByRole('heading', { name: 'Unconfirmed message' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => Object.hasOwn(window, 'phoneFixtureExecuted'))).toBe(false);
  expect(checks).toBe(2);
  expect(pageErrors).toEqual([]);
});

test('staff can review saved request context without owner phone controls', async ({ page }) => {
  await mockRole(page, 'staff');
  const call = phoneCall({
    state: 'STREAMING',
    controlKind: null,
    controlState: null,
    requiresReconciliation: false,
    outcome: 'Reservation request saved for staff review.',
  });
  let item: InboxItem = {
    id: randomUUID(),
    callId: call.id,
    kind: 'reservation',
    state: 'PENDING_STAFF_REVIEW',
    version: 1,
    name: 'Synthetic Guest',
    callbackNumber: '+12125550142',
    reservation: {
      name: 'Synthetic Guest',
      callbackNumber: '+12125550142',
      date: '2026-10-02',
      time: '19:00',
      partySize: 4,
      notes: '',
      timezone: 'America/New_York',
      startsAt: '2026-10-02T23:00:00.000Z',
      referenceAt: instant,
    },
    message: null,
    assignedTo: null,
    leaseExpiresAt: null,
    bookingEvidence: null,
    evidenceSource: null,
    guestNotice: 'PENDING',
    guestNoticeNote: null,
    createdAt: instant,
    updatedAt: instant,
  };
  await page.route('**/api/phone/operations?*', async (route) =>
    route.fulfill({ json: operations([call]) }),
  );
  await page.route(`**/api/phone/calls/${call.id}`, async (route) => {
    const detail: PhoneCallDetail = {
      call,
      context: {
        callId: call.id,
        controlId: randomUUID(),
        reason: 'allergy_question',
        summary: 'Caller wants to discuss a food allergy with staff.',
        createdAt: instant,
        source: 'AI_UNTRUSTED',
      },
      pendingProposal: null,
      savedItem: item,
    };
    await route.fulfill({ json: detail });
  });
  await enter(page);
  await expect(page.getByRole('checkbox', { name: 'Allow new calls', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save phone policy', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /View phone call/ }).click();
  const detail = page.getByRole('region', { name: 'Phone call details' });
  await expect(detail.getByRole('heading', { name: 'Saved guest request' })).toBeVisible();
  await expect(detail).toContainText('The table is not confirmed.');
  await expect(detail).toContainText('Reason: allergy question');
  await expect(
    detail.getByRole('button', { name: 'Check provider status', exact: true }),
  ).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: /Unconfirmed/ })).toHaveCount(0);
  item = {
    ...item,
    version: 2,
    state: 'BOOKED_AWAITING_GUEST_NOTICE',
    bookingEvidence: 'Synthetic booking reference DEMO-PHONE-7.',
    evidenceSource: 'STAFF_REPORTED',
  };
  await page.getByRole('button', { name: 'Refresh phone activity', exact: true }).click();
  await expect(detail).toContainText('Staff reported a booking in their reservation system.');
  await expect(detail).toContainText('DEMO-PHONE-7');
  await expect(detail).toContainText('Guest communication pending.');
  await expect(detail).not.toContainText('The table is not confirmed.');
});

test('viewer sees minimal call activity and never fetches private phone details', async ({
  page,
}) => {
  await mockRole(page, 'viewer');
  const call = phoneCall();
  let detailRequests = 0;
  await page.route('**/api/phone/operations?*', async (route) =>
    route.fulfill({ json: operations([call]) }),
  );
  await page.route(`**/api/phone/calls/${call.id}`, async (route) => {
    detailRequests += 1;
    await route.fulfill({
      status: 403,
      json: { error: { code: 'FORBIDDEN', message: 'Staff access required.' } },
    });
  });
  await enter(page);
  await expect(page.getByRole('checkbox', { name: 'Allow new calls', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /View phone call/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save phone policy', exact: true })).toHaveCount(0);
  await page.evaluate((id) => {
    window.location.hash = `phone/${id}`;
  }, call.id);
  await expect(
    page.getByText('Phone call details require staff or owner access.', { exact: true }),
  ).toBeVisible();
  expect(detailRequests).toBe(0);
});
