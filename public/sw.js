/* eslint-disable no-undef */

// Bulwark service worker.
//
// This SW does two jobs:
//   1. Satisfy the PWA installability requirement (network-only fetch handler,
//      no caching - so we never serve stale chunks after a deployment).
//   2. Receive Web Push wake-up pings from the relay and turn them into
//      enriched system notifications. Mirrors the React Native FCM headless
//      task: relay sends only a state-change ping, the client fetches the
//      newest unread email itself so the relay never sees mail content.

// When the app is mounted at a subpath (Next.js basePath, e.g. /webmail), the
// SW is served at /webmail/sw.js and registered with scope /webmail/. Derive
// the prefix from the SW's own URL so push fetches and notification clicks
// land on the right path - service workers can't read process.env.
function getBasePath() {
  const path = new URL(self.location.href).pathname;
  // self.location is .../sw.js; strip the trailing filename to get the dir,
  // then strip the trailing slash so it concatenates cleanly with `/foo`.
  const dir = path.replace(/[^/]*$/, "");
  return dir.replace(/\/+$/, "");
}

const BASE_PATH = getBasePath();
// Matches the preview API's own cap. A push carrying more than this is a
// backlog replay; the extras stay unannounced rather than burying the shade.
const PREVIEW_ID_LIMIT = 10;
const MAILTO_CLIENTS = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "mailto-client-ready") {
    if (event.source && event.source.id) {
      MAILTO_CLIENTS.set(event.source.id, {
        path: typeof data.path === "string" ? data.path : "",
        standalone: data.standalone === true,
        clientId: typeof data.clientId === "string" ? data.clientId : "",
        focusNotificationTitle: typeof data.focusNotificationTitle === "string" ? data.focusNotificationTitle : "",
        focusNotificationBody: typeof data.focusNotificationBody === "string" ? data.focusNotificationBody : "",
      });
    }
    return;
  }

  if (data.type === "mailto-client-gone") {
    if (event.source && event.source.id) {
      const current = MAILTO_CLIENTS.get(event.source.id);
      if (!current
        || (typeof data.clientId === "string" && current.clientId === data.clientId)
        || (typeof data.clientId !== "string" && typeof data.path === "string" && current.path === data.path)) {
        MAILTO_CLIENTS.delete(event.source.id);
      }
    }
    return;
  }

  if (data.type === "open-mailto-in-client") {
    event.waitUntil(handleOpenMailtoInClient(event));
    return;
  }

  if (data.type === "focus-existing-mailto-client") {
    event.waitUntil(focusExistingWindowClient(event.source && event.source.id, true));
    return;
  }

  if (data.type !== "focus-existing-client") return;

  event.waitUntil(focusExistingWindowClient(event.source && event.source.id));
});

async function handlePush(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (_) {
    payload = null;
  }

  const accountLabel = (payload && typeof payload.accountLabel === "string")
    ? payload.accountLabel
    : "";

  // Three payload shapes reach us from the relay. Two of them name the
  // messages that were actually delivered, which is the difference between
  // "here is your mail" and a guess:
  //
  //   - "EmailPush" (draft-ietf-jmap-emailpush, what Stalwart sends): the
  //     server evaluated our per-account delivery filter and lists the new
  //     messages under `emails`, each carrying the properties we subscribed
  //     for. Spam filed into Junk never gets here. Revision 00 of the same
  //     draft said `@type: "EmailDelivery"` with a single `email`, so that
  //     spelling is read too.
  //   - `emailIds`: the same idea from the Gmail bridge, which predates our
  //     support for the draft's own wording.
  //   - "jmap-state-change" (older servers): a bare EmailDelivery ping wrapped
  //     as { changed: { [accountId]: {...} } }, fired for every ingested
  //     message including junk, with nothing to say about which message it
  //     was. All we can do then is ask for the newest unread in the Inbox.
  //     The relay forwards a single account per push, so the first key is the
  //     one this notification is for.
  const changed = payload && payload.changed && typeof payload.changed === "object"
    ? payload.changed
    : null;
  const accountId = (payload && typeof payload.accountId === "string" && payload.accountId)
    || (changed ? Object.keys(changed)[0] || "" : "");
  const delivered = payload
    ? [
        ...(Array.isArray(payload.emails) ? payload.emails : []),
        ...(payload.email ? [payload.email] : []),
      ]
    : [];
  const emailIds = [
    ...(payload && Array.isArray(payload.emailIds) ? payload.emailIds : []),
    ...delivered.map((mail) => mail && mail.id),
  ].filter((id, index, all) => typeof id === "string" && id && all.indexOf(id) === index);

  // Never notify twice for the same message. A push can be redelivered (relay
  // retry, browser replay after coming back online) and, on the older
  // state-change path, a junk delivery wakes us while an unread message we
  // already announced is still sitting in the Inbox - without this we would
  // re-buzz for that old message.
  const notified = await readNotifiedIds(accountId);
  const freshIds = emailIds.filter((id) => !notified.includes(id));
  if (emailIds.length > 0 && freshIds.length === 0) {
    return;
  }

  // Best effort: ask the webmail to look up the email so we can build a useful
  // notification. With ids from the server we ask for exactly the newest of
  // them; otherwise the API falls back to the newest unread Inbox message. If
  // the request fails (offline, session expired, server down) we fall back to
  // a generic "New mail" so the user still sees something.
  let preview = null;
  let previewOk = false;
  try {
    const query = new URLSearchParams();
    if (accountId) query.set("accountId", accountId);
    // Every id we have not announced yet - the preview API answers with one
    // entry per id so each gets its own notification.
    for (const id of freshIds.slice(-PREVIEW_ID_LIMIT)) query.append("emailId", id);
    const qs = query.toString();
    const previewUrl = `${BASE_PATH}/api/push/preview${qs ? `?${qs}` : ""}`;
    const res = await fetch(previewUrl, {
      credentials: "include",
      cache: "no-store",
    });
    if (res.ok) {
      preview = await res.json();
      previewOk = true;
    }
  } catch (_) {
    preview = null;
  }

  const email = preview && preview.email ? preview.email : null;
  const unreadTotal = preview && typeof preview.unreadTotal === "number"
    ? preview.unreadTotal
    : 0;
  // The relay never echoes accountLabel back in a push (it only uses it for
  // its own /metrics), so the address comes from the preview API's JMAP
  // session. It is what makes two addresses on one device distinguishable.
  const accountName = (preview && preview.account && typeof preview.account.name === "string"
    && preview.account.name) || accountLabel || "";

  // Push subscription is scoped to EmailDelivery, but stragglers from the
  // older broader-types subscription, marking-as-read races and verification
  // pings can still wake us with no actual unread mail. When the preview API
  // succeeded and reports zero unread, stay silent. When the preview API
  // failed (network/auth/server down) we cannot tell, so fall through to the
  // generic "New mail" toast rather than miss a real delivery.
  if (previewOk && !email && unreadTotal === 0) {
    return;
  }

  // State-change path only (no ids from the server): the newest unread Inbox
  // message is one we already announced, so whatever woke us was not new
  // Inbox mail - typically a delivery into Junk or a Sieve-filed folder.
  if (emailIds.length === 0 && previewOk && email && notified.includes(email.id)) {
    return;
  }

  // The browser's own name for this login, which is what a deep link's
  // `?account=` expects - the JMAP account id means nothing to the switcher.
  const loginId = (preview && preview.account && typeof preview.account.loginId === "string"
    && preview.account.loginId) || "";

  // What this push adds, newest last as the preview API returns it.
  const arrived = (preview && Array.isArray(preview.emails) && preview.emails.length > 0)
    ? preview.emails.filter((m) => m && typeof m.id === "string")
    : (email ? [email] : []);

  // One notification per address, the way Gmail groups them: every new mail
  // for an address goes *into* that address's notification instead of
  // standing beside it. The first mail reads like a message - sender, subject,
  // the start of the text on expanding; from the second on the same entry
  // becomes "N new messages (address)" with one line per mail. Addresses stay
  // apart from one another, and the mail already listed is carried over from
  // the notification that is showing, so nothing a previous push announced is
  // lost when the next one lands.
  //
  // The Web Notifications API has no group/summary key, so this is as close
  // to the Gmail app's native groups as a web app gets: one entry per
  // address, replaced in place (same tag), rather than an Android group with
  // one child per message.
  const listed = await takeListedEntries(accountId);

  if (arrived.length === 0) {
    // The preview failed or named nothing. A real delivery is never dropped:
    // if the address already has mail listed, keep the list and say more came
    // in; otherwise a generic toast, which the next real one replaces.
    await postAccountNotification(accountId, accountName, loginId, listed, {
      unknownArrival: true,
      unreadTotal,
    });
    await rememberAnnounced(accountId, notified, freshIds, null);
    return;
  }

  await postAccountNotification(
    accountId,
    accountName,
    loginId,
    mergeEntries(listed, arrived.map(entryFromPreview)),
    {},
  );
  await rememberAnnounced(accountId, notified, freshIds, arrived);
}

const MAX_LISTED_ENTRIES = 20;
const MAX_BODY_LINES = 6;

function accountTag(accountId) {
  return "bulwark-mail:" + (accountId || "default");
}

function entryFromPreview(message) {
  const sender = message.from && message.from[0];
  return {
    id: message.id,
    threadId: message.threadId || null,
    sender: (sender && sender.name) || (sender && sender.email) || "",
    subject: message.subject || "",
    snippet: (message.preview || "").trim(),
    receivedAt: message.receivedAt || new Date().toISOString(),
  };
}

/**
 * The mail this address's notification already lists, read back so the next
 * push can add to it rather than replace it.
 *
 * Notifications from the build before this one were one per message
 * (`bulwark-mail:<account>:<email>`); they are folded in here and closed, so
 * the shade converges on one entry per address after the update instead of
 * keeping the old stack alongside the new one.
 */
async function takeListedEntries(accountId) {
  if (typeof self.registration.getNotifications !== "function") return [];
  const tag = accountTag(accountId);
  let showing = [];
  try {
    showing = await self.registration.getNotifications();
  } catch (_) {
    return [];
  }
  const entries = [];
  for (const notification of showing) {
    const data = notification.data || {};
    if (notification.tag === tag) {
      if (Array.isArray(data.entries)) entries.push(...data.entries);
    } else if (notification.tag.startsWith(tag + ":")) {
      const [subject, ...rest] = String(notification.body || "").split("\n");
      entries.push({
        id: data.emailId || notification.tag.slice(tag.length + 1),
        threadId: data.threadId || null,
        sender: String(notification.title || "").replace(/ \([^()]*\)$/, ""),
        subject: subject || "",
        snippet: rest.join(" ").trim(),
        receivedAt: new Date(notification.timestamp || Date.now()).toISOString(),
      });
      notification.close();
    }
  }
  return entries.filter((entry) => entry && typeof entry.id === "string");
}

/** Newest first, one entry per message, bounded so the notification's data stays small. */
function mergeEntries(listed, arrived) {
  const byId = new Map();
  for (const entry of [...listed, ...arrived]) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0))
    .slice(0, MAX_LISTED_ENTRIES);
}

async function postAccountNotification(accountId, accountName, loginId, entries, options) {
  const withAddress = (text) => (accountName ? `${text} (${accountName})` : text);
  const newest = entries[0];
  let title;
  let body;
  let data;

  if (entries.length === 0) {
    title = withAddress("New mail");
    body = options.unreadTotal > 1 ? `${options.unreadTotal} unread messages` : "You have new mail";
    data = { kind: "mail-list", accountId, loginId, entries: [] };
  } else if (entries.length === 1 && !options.unknownArrival) {
    // A single mail reads like the message itself: subject on the first line,
    // the start of the text under it (Android shows it on expanding), and a
    // tap opens that message.
    title = withAddress(newest.sender || "New mail");
    body = newest.snippet
      ? `${newest.subject || "(no subject)"}\n${newest.snippet}`
      : newest.subject || "(no subject)";
    data = {
      kind: "email",
      emailId: newest.id,
      threadId: newest.threadId,
      accountId,
      loginId,
      entries,
    };
  } else {
    // Several: one line per mail, newest on top - collapsed, Android shows the
    // newest; expanded, the list. A tap opens this address's inbox.
    const lines = entries.slice(0, MAX_BODY_LINES).map((entry) =>
      `${entry.sender || "New mail"}: ${entry.subject || "(no subject)"}`);
    if (entries.length > MAX_BODY_LINES) lines.push(`+${entries.length - MAX_BODY_LINES} more`);
    if (options.unknownArrival) lines.unshift("New mail");
    const count = entries.length + (options.unknownArrival ? 1 : 0);
    title = withAddress(`${count} new messages`);
    body = lines.join("\n");
    data = { kind: "mail-list", accountId, loginId, entries };
  }

  const quiet = await withinQuietWindow();
  await self.registration.showNotification(title, {
    body,
    tag: accountTag(accountId),
    icon: `${BASE_PATH}/api/pwa-icon/192`,
    badge: `${BASE_PATH}/api/pwa-icon/192`,
    timestamp: (newest && Date.parse(newest.receivedAt)) || Date.now(),
    data,
    // Same tag, so this replaces the address's entry; renotify makes the
    // replacement alert as a new arrival rather than update silently. Inside
    // the quiet window the entry still appears or updates, without a sound.
    renotify: !quiet,
    silent: quiet,
  });
}

// One message often lands in several of the user's addresses at once - a
// list, a forward, the same newsletter on two logins - and each address has
// its own notification. Only the first alert of a burst makes a sound; the
// ones that follow within the window show up silently. The window runs from
// the last audible alert and is not extended by the silent ones, so a steady
// trickle still rings every so often.
const QUIET_WINDOW_MS = 30_000;

function lastAlertKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/last-alert`;
}

/** True when an audible alert went off less than QUIET_WINDOW_MS ago; otherwise records this one. */
async function withinQuietWindow() {
  const now = Date.now();
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(lastAlertKey());
    const last = res ? Number((await res.json()).at) : 0;
    if (last && now - last >= 0 && now - last < QUIET_WINDOW_MS) return true;
    await cache.put(
      lastAlertKey(),
      new Response(JSON.stringify({ at: now }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // Without the store every notification alerts, as before.
  }
  return false;
}

// Record which message ids this push announced so a redelivery stays quiet.
async function rememberAnnounced(accountId, notified, freshIds, messages) {
  const fromMessages = messages ? messages.map((m) => m.id) : [];
  const announced = fromMessages.length > 0 ? fromMessages : freshIds;
  if (announced.length > 0) {
    await writeNotifiedIds(accountId, notified.concat(announced));
  }
}

// Per-account list of message ids we have already shown a notification for.
// Service workers have no localStorage; the Cache API is the cheapest durable
// store that survives the worker being killed between pushes. Failures are
// swallowed - dedupe is a nicety, delivering the notification is not.
const PUSH_STATE_CACHE = "bulwark-push-state-v1";
const NOTIFIED_IDS_LIMIT = 200;

function notifiedIdsKey(accountId) {
  return `${self.location.origin}${BASE_PATH}/__push-state/notified/${encodeURIComponent(accountId || "default")}`;
}

async function readNotifiedIds(accountId) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(notifiedIdsKey(accountId));
    if (!res) return [];
    const data = await res.json();
    return Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === "string") : [];
  } catch (_) {
    return [];
  }
}

async function writeNotifiedIds(accountId, ids) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const unique = Array.from(new Set(ids)).slice(-NOTIFIED_IDS_LIMIT);
    await cache.put(
      notifiedIdsKey(accountId),
      new Response(JSON.stringify({ ids: unique }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // Best effort only.
  }
}

async function handleNotificationClick(event) {
  const data = event.notification.data || {};
  const tag = event.notification.tag || "";

  if (data.kind === "protocol-mailto-focus") {
    return handleMailtoFocusNotificationClick();
  }

  const targetUrl = buildClickUrl(data);

  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  // Notify any in-app clients so plugins listening on toastHooks.onNotificationClick fire.
  for (const client of allClients) {
    try {
      client.postMessage({ kind: "notificationclick", tag, data });
    } catch (_) {
      // Closed or detached client - ignore.
    }
  }

  for (const client of allClients) {
    // Reuse an existing tab whenever possible - users on desktop browsers
    // get annoyed when each notification opens a fresh window.
    if ("focus" in client) {
      try {
        // FOCUS FIRST, NAVIGATE SECOND, and the order is the entire fix.
        //
        // A notification click grants the service worker a TRANSIENT USER ACTIVATION, and
        // both focus() and openWindow() refuse to run without one. navigate() SPENDS that
        // activation, and it also replaces the client's document, which invalidates the
        // WindowClient handle we are about to use. Navigating first therefore breaks the
        // click two ways over. Instrumented on Android in a real deployment:
        //
        //   client 1: navigate ok -> focus() threw NotFoundError      (handle stale after nav)
        //   client 2: navigate ok -> focus() threw InvalidAccessError (activation spent)
        //   openWindow()          -> threw InvalidAccessError         (same)
        //
        // Every rejection was swallowed by the catch below, so the toast closed and nothing
        // came to the front. Focusing first uses the activation while it is still live;
        // navigate() does not need one of its own once the client is focused.
        const focused = await client.focus();
        if (focused && "navigate" in focused && targetUrl) {
          try {
            await focused.navigate(targetUrl);
          } catch (_) {
            // Focused but not navigated still beats nothing opening at all.
          }
        }
        return focused;
      } catch (_) {
        // navigate() can reject for cross-origin or detached clients - fall
        // through and open a new window below.
      }
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl || `${BASE_PATH}/`);
  }
}

async function focusExistingWindowClient(sourceClientId, requireMailtoReady) {
  const entry = await findReusableWindowClientEntry(sourceClientId, requireMailtoReady);
  const client = entry && entry.client;
  if (client && "focus" in client) {
    return client.focus();
  }
}

async function handleMailtoFocusNotificationClick() {
  const entry = await findReusableWindowClientEntry(null, true);
  const client = entry && entry.client;
  if (client && "focus" in client) {
    try {
      return await client.focus();
    } catch (_) {
      // Fall through to opening a new app window if activation is still blocked.
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(`${BASE_PATH}/`);
  }
}

async function handleOpenMailtoInClient(event) {
  const data = event.data || {};
  const responsePort = event.ports && event.ports[0];
  const entry = await findReusableWindowClientEntry(event.source && event.source.id, true);
  const client = entry && entry.client;
  const state = entry && entry.state;

  if (!client || !state || !state.clientId) {
    responsePort && responsePort.postMessage({ delivered: false });
    return;
  }

  try {
    client.postMessage({ type: "mailto-request", id: data.id, clientId: state.clientId, value: data.value });
  } catch (_) {
    responsePort && responsePort.postMessage({ delivered: false });
    return;
  }

  if ("focus" in client) {
    try {
      await client.focus();
    } catch (_) {
      // Delivery succeeded; focusing can still be blocked by browser policy.
      await showMailtoFocusNotification(state);
    }
  }

  responsePort && responsePort.postMessage({ delivered: true });
}

async function showMailtoFocusNotification(state) {
  try {
    await self.registration.showNotification(state.focusNotificationTitle || "Bulwark", {
      body: state.focusNotificationBody || "The request was opened in Bulwark. Click to bring it to the front.",
      tag: "bulwark-mailto-focus",
      icon: `${BASE_PATH}/api/pwa-icon/192`,
      badge: `${BASE_PATH}/api/pwa-icon/192`,
      data: { kind: "protocol-mailto-focus" },
      renotify: true,
    });
  } catch (_) {
    // Notification permission may be missing; the mailto request was still delivered.
  }
}

async function findReusableWindowClientEntry(sourceClientId, requireMailtoReady) {
  const scopedPath = BASE_PATH ? `${BASE_PATH}/` : "/";
  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const candidates = [];

  for (const client of allClients) {
    if (client.id === sourceClientId) continue;
    const state = MAILTO_CLIENTS.get(client.id);
    if (requireMailtoReady && !state) continue;

    try {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin) continue;
      if (!url.pathname.startsWith(scopedPath)) continue;
      if (url.pathname.includes("/protocol/")) continue;

      candidates.push({ client, state, score: getReusableClientScore(state) });
    } catch (_) {
      // Detached clients can disappear while iterating.
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

/**
 * Whether a client's path is the mail section. Since #733 the mail client
 * keeps a permalink in the address bar, so an open inbox reads as
 * `/mail/folder/inbox` (optionally behind a mount prefix and a locale
 * segment) rather than a bare "/".
 *
 * Deliberately duplicated from lib/deep-links.ts: this file is served raw, not
 * bundled, so it cannot import from the app. The locale segment is matched by
 * shape (two lowercase letters) because the worker has no locale list - and no
 * app route is a bare two-letter segment.
 */
function isMailSectionPath(path) {
  if (!path) return true;
  let rest = path;
  if (BASE_PATH && (rest === BASE_PATH || rest.startsWith(`${BASE_PATH}/`))) {
    rest = rest.slice(BASE_PATH.length);
  }
  const segments = rest.split("/").filter(Boolean);
  if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) segments.shift();
  return segments.length === 0 || segments[0] === "mail";
}

function getReusableClientScore(state) {
  if (!state) return 4;

  const isMailSection = isMailSectionPath(state.path);
  if (state.standalone && isMailSection) return 0;
  if (isMailSection) return 1;
  if (state.standalone) return 2;
  return 3;
}

function buildClickUrl(data) {
  if (!data) return `${BASE_PATH}/`;
  // `?account=` switches to the mailbox the notification is about first:
  // with several logins, the active one is often not it.
  const account = data.loginId ? `?account=${encodeURIComponent(data.loginId)}` : "";
  if (data.kind === "email" && data.emailId) {
    // Permalink (#733). Under NEXT_PUBLIC_LOCALE_PREFIX=always the proxy
    // redirects this to the localised path; the worker has no locale to add.
    return `${BASE_PATH}/mail/message/${encodeURIComponent(data.emailId)}${account}`;
  }
  if (data.kind === "mail-list" && data.loginId) {
    // Several mails for one address: its inbox, like tapping a Gmail group.
    return `${BASE_PATH}/mail/folder/inbox${account}`;
  }
  // Generic "New mail" toast (preview API failed or returned no email): land
  // the user on the latest unread message in their Inbox rather than just the
  // app shell, so the click still feels purposeful.
  return `${BASE_PATH}/?openLatestUnread=1`;
}
