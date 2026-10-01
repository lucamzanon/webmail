import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/account-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-utils')>()),
  MAX_ACCOUNT_SLOTS: 2,
}));

// Two logins on one server. "boss" also sees ambrogio's mailbox shared; the
// server's principal for ambrogio@example.com is named "alfred".
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) =>
    slot === 0 ? { serverUrl: 'https://mail.example.com/', username: 'boss@example.com', authHeader: 'Bearer boss' }
      : slot === 1 ? { serverUrl: 'https://mail.example.com/', username: 'ambrogio@example.com', authHeader: 'Bearer ambrogio' }
        : null,
}));

vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(),
}));

const fetchJmapServer = vi.fn();
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: (...args: unknown[]) => fetchJmapServer(...args),
  isTrustedJmapServerUrl: async () => true,
}));

vi.mock('@/lib/security/url-guard', () => ({
  DisallowedUrlError: class DisallowedUrlError extends Error {},
}));

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data };
}

const SESSIONS: Record<string, unknown> = {
  'Bearer boss': {
    apiUrl: 'https://mail.example.com/jmap',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'b' },
    accounts: { b: { name: 'boss' }, x: { name: 'alfred' } },
  },
  'Bearer ambrogio': {
    apiUrl: 'https://mail.example.com/jmap',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'x' },
    accounts: { x: { name: 'alfred' } },
  },
};

function mockJmap() {
  fetchJmapServer.mockImplementation(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (url.endsWith('/.well-known/jmap')) return jsonResponse(SESSIONS[init?.headers?.Authorization ?? '']);
    const body = JSON.parse(init?.body ?? '{}') as { methodCalls: [string, Record<string, unknown>, string][] };
    if (body.methodCalls[0][0] === 'Mailbox/query') {
      return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] });
    }
    return jsonResponse({
      methodResponses: [
        ['Email/query', { ids: ['e1'], total: 1 }, 'eq'],
        ['Email/get', { list: [{ id: 'e1', threadId: 't1', subject: 'Hi' }] }, 'eg'],
      ],
    });
  });
}

async function callRoute(accountId: string) {
  const { GET } = await import('@/app/api/push/preview/route');
  const request = {
    nextUrl: { searchParams: { get: (k: string) => (k === 'accountId' ? accountId : null), getAll: () => [] } },
  };
  const res = (await GET(request as unknown as Parameters<typeof GET>[0])) as unknown as {
    json: () => Promise<Record<string, unknown>>;
  };
  return res.json();
}

describe('push preview account naming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJmap();
  });

  it('names a login\'s own account by the address it signs in with, in that login', async () => {
    const body = await callRoute('x');
    expect(body.account).toEqual({ id: 'x', name: 'ambrogio@example.com', loginId: 'ambrogio@example.com@mail.example.com' });
    expect(body.slot).toBe(1);
  });

  it('names the other login\'s own account by its address too', async () => {
    const body = await callRoute('b');
    expect(body.account).toMatchObject({ id: 'b', name: 'boss@example.com', loginId: 'boss@example.com@mail.example.com' });
  });
});
