import { beforeAll, expect, it, vi } from 'vitest';

// Settings are one set per user, kept on the main (default) account: switching
// to another account must neither load that account's stored copy nor save
// edits to it.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'a', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
    getAccountId() { return 'acct'; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = acct('a@x.test', 'mail.x.test', 0);
const B = acct('b@x.test', 'mail.x.test', 1);
const posts: string[] = [];
const loads: string[] = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/api\/auth\/session\?slot=(\d)/);
    if (m && init?.method === 'PUT') {
      const a = [A, B][Number(m[1])];
      return new Response(JSON.stringify({ serverUrl: a.serverUrl, username: a.username, password: 'pw' }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify({ settingsSyncEnabled: true }), { status: 200 });
    if (url.includes('/api/settings') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)).username);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/api/settings')) {
      loads.push(new Headers(init?.headers).get('x-settings-username') ?? '');
      return new Response(JSON.stringify({ settings: null }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

it('loads and saves the main account\'s settings whichever account is active', async () => {
  useAccountStore.setState({ accounts: [A, B] as never, activeAccountId: A.id, defaultAccountId: A.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: A.id, client: null });
  await useAuthStore.getState().switchAccount(B.id);
  await sleep(50);
  expect(useAuthStore.getState().activeAccountId).toBe(B.id);
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.every((u) => u === 'a@x.test')).toBe(true);

  posts.length = 0;
  useSettingsStore.getState().updateSetting('fontSize', 'large' as never);
  await sleep(2300);
  expect(posts).toEqual(['a@x.test']);
}, 15000);
