import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// public/sw.js is served raw, never bundled, so it cannot be imported. Run it
// in a VM with a hand-rolled ServiceWorkerGlobalScope and drive the push
// listener directly.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Notification = { title: string; options: Record<string, unknown> };

function loadWorker(previewResponse: unknown, previewOk = true) {
  const listeners = new Map<string, (event: unknown) => void>();
  const notifications: Notification[] = [];
  const showing: { tag: string; close: () => void }[] = [];
  const closed: string[] = [];
  const cacheStore = new Map<string, string>();

  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        notifications.push({ title, options });
        showing.push({ tag: String(options.tag ?? ''), close: () => closed.push(String(options.tag ?? '')) });
      },
      getNotifications: async ({ tag }: { tag: string }) => showing.filter((n) => n.tag === tag),
    },
  };

  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = cacheStore.get(key);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => {
        cacheStore.set(key, await res.text());
      },
    }),
  };

  let previewWorks = previewOk;
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: previewWorks,
    json: async () => previewResponse,
  }));

  const context = vm.createContext({
    self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console,
  });
  vm.runInContext(SW_SOURCE, context);

  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  }

  return { push, notifications, fetchMock, closed, showing, repairPreview: () => { previewWorks = true; } };
}

const BURST = {
  account: { id: 'acct', name: 'lu@ma.gl' },
  unreadTotal: 2,
  email: { id: 'e2', threadId: 't2', subject: 'Second', preview: 'body two' },
  emails: [
    { id: 'e1', threadId: 't1', from: [{ name: 'Alice' }], subject: 'First', preview: 'body one' },
    { id: 'e2', threadId: 't2', from: [{ email: 'bob@example.com' }], subject: 'Second', preview: 'body two' },
  ],
};

describe('service worker push notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts one notification per message, tagged per message and stamped with the address', async () => {
    const { push, notifications } = loadWorker(BURST);

    await push({ accountId: 'acct', emailIds: ['e1', 'e2'] });

    expect(notifications).toHaveLength(2);
    expect(notifications[0].title).toBe('Alice (lu@ma.gl)');
    expect(notifications[1].title).toBe('bob@example.com (lu@ma.gl)');
    // Subject on the first line, message text under it: Android renders the
    // rest as BigText when the entry is expanded.
    expect(notifications[0].options.body).toBe('First\nbody one');
    expect(notifications.map((n) => n.options.tag)).toEqual([
      'bulwark-mail:acct:e1',
      'bulwark-mail:acct:e2',
    ]);
    // Each opens its own message.
    expect(notifications[0].options.data).toMatchObject({ kind: 'email', emailId: 'e1' });
    // Only the newest alerts; the rest land quietly under it.
    expect(notifications.map((n) => n.options.silent)).toEqual([true, false]);
  });

it('retires the account summary a failed preview left in the shade', async () => {
    // First push: the preview API is down, so the account gets the generic
    // one-per-account toast. Second push: the preview works, and the real
    // per-message entries replace nothing - their tags differ - so the
    // summary has to be closed or it outlives the mail it stands for.
    const { push, notifications, closed, repairPreview } = loadWorker(BURST, false);
    await push({ accountId: 'acct', emailIds: ['e0'] });
    expect(notifications[0].options.tag).toBe('bulwark-mail:acct');
    expect(closed).toEqual([]);

    repairPreview();
    await push({ accountId: 'acct', emailIds: ['e1', 'e2'] });
    expect(closed).toEqual(['bulwark-mail:acct']);
  });

it('reads the delivered ids out of a standard EmailPush payload', async () => {
    // What Stalwart sends (draft-ietf-jmap-emailpush): the messages that
    // passed the delivery filter, each with the properties we subscribed for.
    // Before this the SW saw no ids here and fell back to "newest unread in
    // the Inbox", which is a different message whenever mail is read out of
    // order - or none at all, and then the user got a bare "New mail".
    const { push, notifications, fetchMock } = loadWorker(BURST);

    await push({
      '@type': 'EmailPush',
      accountId: 'acct',
      emails: [{ id: 'e1', threadId: 't1' }, { id: 'e2', threadId: 't2' }],
      state: 'XH99813',
    });

    const url = new URL(fetchMock.mock.calls[0][0], 'https://mail.example.com');
    expect(url.searchParams.getAll('emailId')).toEqual(['e1', 'e2']);
    expect(notifications.map((n) => n.options.tag)).toEqual([
      'bulwark-mail:acct:e1',
      'bulwark-mail:acct:e2',
    ]);
  });

  it('reads revision 00 of the draft, which named a single email', async () => {
    const { push, fetchMock } = loadWorker(BURST);

    await push({ '@type': 'EmailDelivery', accountId: 'acct', email: { id: 'e2' } });

    const url = new URL(fetchMock.mock.calls[0][0], 'https://mail.example.com');
    expect(url.searchParams.getAll('emailId')).toEqual(['e2']);
  });

  it('asks the preview API for every unannounced id', async () => {
    const { push, fetchMock } = loadWorker(BURST);

    await push({ accountId: 'acct', emailIds: ['e1', 'e2'] });

    // The SW builds a path-relative URL from its own scope.
    const url = new URL(fetchMock.mock.calls[0][0], 'https://mail.example.com');
    expect(url.searchParams.getAll('emailId')).toEqual(['e1', 'e2']);
  });

  it('does not re-notify for a message already announced', async () => {
    const { push, notifications } = loadWorker(BURST);

    await push({ accountId: 'acct', emailIds: ['e1', 'e2'] });
    await push({ accountId: 'acct', emailIds: ['e1', 'e2'] });

    expect(notifications).toHaveLength(2);
  });

  it('falls back to a generic toast when the preview API fails', async () => {
    const { push, notifications } = loadWorker(null, false);

    await push({ accountId: 'acct', emailIds: ['e1'] });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('New mail');
    expect(notifications[0].options.tag).toBe('bulwark-mail:acct');
  });

  it('stays silent when the preview reports nothing unread', async () => {
    const { push, notifications } = loadWorker({ email: null, emails: [], unreadTotal: 0 });

    await push({ accountId: 'acct', emailIds: [] });

    expect(notifications).toHaveLength(0);
  });
});
