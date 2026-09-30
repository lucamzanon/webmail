import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// public/sw.js is served raw, never bundled, so it cannot be imported. Run it
// in a VM with a hand-rolled ServiceWorkerGlobalScope and drive the push
// listener directly.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Shown = {
  tag: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  timestamp: number;
  options: Record<string, unknown>;
  close: () => void;
};

type Preview = (url: URL) => unknown;

/**
 * A worker with a shade that behaves like the browser's: a notification with
 * a tag already showing is replaced, not stacked, and getNotifications()
 * reads back what is currently showing.
 */
function loadWorker(preview: unknown | Preview, previewOk = true) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shade = new Map<string, Shown>();
  const posted: Shown[] = [];
  const closed: string[] = [];
  const cacheStore = new Map<string, string>();

  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        const tag = String(options.tag ?? '');
        const shown: Shown = {
          tag,
          title,
          body: String(options.body ?? ''),
          data: (options.data ?? {}) as Record<string, unknown>,
          timestamp: Number(options.timestamp ?? Date.now()),
          options,
          close: () => { shade.delete(tag); closed.push(tag); },
        };
        shade.set(tag, shown);
        posted.push(shown);
      },
      getNotifications: async (filter?: { tag?: string }) =>
        [...shade.values()].filter((n) => !filter?.tag || n.tag === filter.tag),
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
  const fetchMock = vi.fn(async (url: string) => ({
    ok: previewWorks,
    json: async () => (typeof preview === 'function'
      ? (preview as Preview)(new URL(url, 'https://mail.example.com'))
      : preview),
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

  const clickUrl = (data: unknown) =>
    vm.runInContext(`buildClickUrl(${JSON.stringify(data)})`, context) as string;

  return {
    push, shade, posted, closed, fetchMock, clickUrl,
    repairPreview: () => { previewWorks = true; },
  };
}

type Mail = {
  id: string; threadId: string; from: { name?: string; email?: string }[];
  subject: string; preview: string; receivedAt: string;
};
const ALICE: Mail = {
  id: 'e1', threadId: 't1', from: [{ name: 'Alice' }], subject: 'First', preview: 'body one',
  receivedAt: '2026-09-24T09:00:00Z',
};
const BOB: Mail = {
  id: 'e2', threadId: 't2', from: [{ email: 'bob@example.com' }], subject: 'Second', preview: 'body two',
  receivedAt: '2026-09-24T10:00:00Z',
};
const ACCOUNT = { id: 'acct', name: 'lu@ma.gl', loginId: 'lu@ma.gl@mail.ma.gl' };

/** The preview API as the route answers it: the requested ids, oldest first. */
function previewOf(...mail: Mail[]) {
  return (url: URL) => {
    const ids = url.searchParams.getAll('emailId');
    const emails = mail.filter((m) => ids.includes(m.id));
    return { account: ACCOUNT, unreadTotal: emails.length, email: emails.at(-1) ?? null, emails };
  };
}

describe('service worker push notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a single mail as the message itself, on its address\'s entry', async () => {
    const { push, shade } = loadWorker(previewOf(ALICE));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });

    expect([...shade.keys()]).toEqual(['bulwark-mail:acct']);
    const n = shade.get('bulwark-mail:acct')!;
    expect(n.title).toBe('Alice (lu@ma.gl)');
    // Subject on the first line, the start of the text under it: Android
    // shows the rest on expanding.
    expect(n.body).toBe('First\nbody one');
    expect(n.data).toMatchObject({ kind: 'email', emailId: 'e1', loginId: 'lu@ma.gl@mail.ma.gl' });
  });

  it('puts two mails for one address into one notification, one line each, newest first', async () => {
    const { push, shade, posted } = loadWorker(previewOf(ALICE, BOB));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }, { id: 'e2' }] });

    expect(shade.size).toBe(1);
    const n = shade.get('bulwark-mail:acct')!;
    expect(n.title).toBe('2 new messages (lu@ma.gl)');
    expect(n.body).toBe('bob@example.com: Second\nAlice: First');
    expect(n.data).toMatchObject({ kind: 'mail-list', loginId: 'lu@ma.gl@mail.ma.gl' });
    // One arrival, one alert.
    expect(posted).toHaveLength(1);
    expect(n.options.renotify).toBe(true);
  });

  it('adds a later mail to the notification already showing for that address', async () => {
    const { push, shade } = loadWorker(previewOf(ALICE, BOB));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });
    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e2' }] });

    expect(shade.size).toBe(1);
    const n = shade.get('bulwark-mail:acct')!;
    expect(n.title).toBe('2 new messages (lu@ma.gl)');
    expect(n.body).toBe('bob@example.com: Second\nAlice: First');
  });

  it('keeps different addresses apart', async () => {
    const other = { id: 'other', name: 'luca@orofruit.com', loginId: 'luca@orofruit.com@bridge.ma.gl' };
    const { push, shade } = loadWorker((url: URL) => (url.searchParams.get('accountId') === 'other'
      ? { account: other, unreadTotal: 1, email: BOB, emails: [BOB] }
      : { account: ACCOUNT, unreadTotal: 1, email: ALICE, emails: [ALICE] }));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });
    await push({ '@type': 'EmailPush', accountId: 'other', emails: [{ id: 'e2' }] });

    expect(shade.get('bulwark-mail:acct')!.title).toBe('Alice (lu@ma.gl)');
    expect(shade.get('bulwark-mail:other')!.title).toBe('bob@example.com (luca@orofruit.com)');
  });

  it('rings once for a burst across addresses, and again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
      const other = { id: 'other', name: 'luca@orofruit.com', loginId: 'luca@orofruit.com@bridge.ma.gl' };
      const { push, shade } = loadWorker((url: URL) => (url.searchParams.get('accountId') === 'other'
        ? { account: other, unreadTotal: 1, email: BOB, emails: [BOB] }
        : { account: ACCOUNT, unreadTotal: 1, email: ALICE, emails: [ALICE] }));

      await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });
      expect(shade.get('bulwark-mail:acct')!.options).toMatchObject({ renotify: true, silent: false });

      vi.setSystemTime(new Date('2026-09-30T10:00:05Z'));
      await push({ '@type': 'EmailPush', accountId: 'other', emails: [{ id: 'e2' }] });
      // Shown, but without a second sound.
      expect(shade.get('bulwark-mail:other')!.options).toMatchObject({ renotify: false, silent: true });

      vi.setSystemTime(new Date('2026-09-30T10:00:40Z'));
      await push({ '@type': 'EmailPush', accountId: 'other', emails: [{ id: 'e3' }] });
      expect(shade.get('bulwark-mail:other')!.options).toMatchObject({ renotify: true, silent: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts fresh once the address\'s notification has been dismissed', async () => {
    const { push, shade } = loadWorker(previewOf(ALICE, BOB));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });
    shade.get('bulwark-mail:acct')!.close();
    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e2' }] });

    expect(shade.get('bulwark-mail:acct')!.title).toBe('bob@example.com (lu@ma.gl)');
  });

  it('folds the one-per-message notifications of the previous build into the address\'s entry', async () => {
    const worker = loadWorker(previewOf(ALICE));
    // What the build before this one left in the shade.
    worker.shade.set('bulwark-mail:acct:e0', {
      tag: 'bulwark-mail:acct:e0',
      title: 'Carol (lu@ma.gl)',
      body: 'Old news\nold body',
      data: { kind: 'email', emailId: 'e0' },
      timestamp: Date.parse('2026-09-24T08:00:00Z'),
      options: {},
      close: () => { worker.shade.delete('bulwark-mail:acct:e0'); worker.closed.push('bulwark-mail:acct:e0'); },
    });

    await worker.push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });

    expect(worker.closed).toContain('bulwark-mail:acct:e0');
    expect([...worker.shade.keys()]).toEqual(['bulwark-mail:acct']);
    expect(worker.shade.get('bulwark-mail:acct')!.body).toBe('Alice: First\nCarol: Old news');
  });

  it('lists at most six mails and counts the rest', async () => {
    const mail = Array.from({ length: 8 }, (_, i) => ({
      ...ALICE, id: `m${i}`, subject: `Subject ${i}`, receivedAt: `2026-09-24T0${i}:00:00Z`,
    }));
    const { push, shade } = loadWorker(previewOf(...mail));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: mail.map((m) => ({ id: m.id })) });

    const n = shade.get('bulwark-mail:acct')!;
    expect(n.title).toBe('8 new messages (lu@ma.gl)');
    const lines = n.body.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('Alice: Subject 7');
    expect(lines[6]).toBe('+2 more');
  });

  it('opens the mailbox the notification is about, not whichever is active', () => {
    const { clickUrl } = loadWorker(previewOf(ALICE));

    expect(clickUrl({ kind: 'email', emailId: 'e1', loginId: 'lu@ma.gl@mail.ma.gl' }))
      .toBe('/mail/message/e1?account=lu%40ma.gl%40mail.ma.gl');
    expect(clickUrl({ kind: 'mail-list', loginId: 'lu@ma.gl@mail.ma.gl' }))
      .toBe('/mail/folder/inbox?account=lu%40ma.gl%40mail.ma.gl');
    // Without a login id there is nothing to switch to: the newest unread.
    expect(clickUrl({ kind: 'mail-list' })).toBe('/?openLatestUnread=1');
  });

  it('reads the delivered ids out of a standard EmailPush payload', async () => {
    // What Stalwart sends (draft-ietf-jmap-emailpush): the messages that
    // passed the delivery filter, each with the properties we subscribed for.
    const { push, fetchMock } = loadWorker(previewOf(ALICE, BOB));

    await push({
      '@type': 'EmailPush',
      accountId: 'acct',
      emails: [{ id: 'e1', threadId: 't1' }, { id: 'e2', threadId: 't2' }],
      state: 'XH99813',
    });

    const url = new URL(fetchMock.mock.calls[0][0], 'https://mail.example.com');
    expect(url.searchParams.getAll('emailId')).toEqual(['e1', 'e2']);
  });

  it('reads revision 00 of the draft, which named a single email', async () => {
    const { push, fetchMock } = loadWorker(previewOf(BOB));

    await push({ '@type': 'EmailDelivery', accountId: 'acct', email: { id: 'e2' } });

    const url = new URL(fetchMock.mock.calls[0][0], 'https://mail.example.com');
    expect(url.searchParams.getAll('emailId')).toEqual(['e2']);
  });

  it('still reads the Gmail bridge\'s emailIds', async () => {
    const { push, fetchMock } = loadWorker(previewOf(ALICE, BOB));

    await push({ accountId: 'acct', emailIds: ['e1', 'e2'] });

    const url = new URL(fetchMock.mock.calls[0][0], 'https://mail.example.com');
    expect(url.searchParams.getAll('emailId')).toEqual(['e1', 'e2']);
  });

  it('does not re-notify for a message already announced', async () => {
    const { push, posted } = loadWorker(previewOf(ALICE));

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });
    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });

    expect(posted).toHaveLength(1);
  });

  it('falls back to a generic toast when the preview fails, and the real mail replaces it', async () => {
    const { push, shade, repairPreview } = loadWorker(previewOf(ALICE), false);

    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e0' }] });
    expect(shade.get('bulwark-mail:acct')!.title).toBe('New mail');

    repairPreview();
    await push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }] });

    expect(shade.size).toBe(1);
    expect(shade.get('bulwark-mail:acct')!.title).toBe('Alice (lu@ma.gl)');
  });

  it('keeps the list when a later preview fails, and says more came in', async () => {
    const worker = loadWorker(previewOf(ALICE, BOB));
    await worker.push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e1' }, { id: 'e2' }] });

    const failing = loadWorker(null, false);
    // Same shade, a worker whose preview is down.
    failing.shade.set('bulwark-mail:acct', worker.shade.get('bulwark-mail:acct')!);
    await failing.push({ '@type': 'EmailPush', accountId: 'acct', emails: [{ id: 'e3' }] });

    const n = failing.shade.get('bulwark-mail:acct')!;
    expect(n.title).toBe('3 new messages');
    expect(n.body.split('\n')).toEqual(['New mail', 'bob@example.com: Second', 'Alice: First']);
  });

  it('stays silent when the preview reports nothing unread', async () => {
    const { push, posted } = loadWorker({ account: ACCOUNT, unreadTotal: 0, email: null, emails: [] });

    await push({ '@type': 'StateChange', changed: { acct: { EmailDelivery: 's1' } } });

    expect(posted).toHaveLength(0);
  });
});
