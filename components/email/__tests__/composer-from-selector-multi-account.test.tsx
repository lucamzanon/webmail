import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';

// Gmail-style sender picker: with more than one account connected the From
// field lists every account's identities, grouped by account. Previously this
// only happened in the Pro shell. The default selection must be the ACTIVE
// account's identity as it appears in that aggregated list - i.e. carrying the
// "<localAccountId>::" namespace - or the dropdown shows one address while
// the composer sends through another.

// ─── Heavy component mocks (mirrors composer-draft-attachments.test.tsx) ─────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
// Two connected accounts: the hook aggregates their identities and namespaces
// every id with the local account that owns it. Mutable so a test can drop the
// active account's group (an account with no identity of its own).
const { identityGroups } = vi.hoisted(() => ({
  identityGroups: {
    current: [
      {
        localAccountId: 'acct-1',
        accountLabel: 'Work',
        identities: [
          { id: 'acct-1::id-1', email: 'me@work.example', name: 'Me' },
          { id: 'acct-1::id-1b', email: 'info@work.example', name: 'Info' },
        ],
      },
      {
        localAccountId: 'acct-2',
        accountLabel: 'Personal',
        identities: [{ id: 'acct-2::id-other', email: 'other@example.com', name: 'Other' }],
      },
    ],
  },
}));
const ALL_GROUPS = identityGroups.current;

vi.mock('@/hooks/use-multi-account-identities', () => ({
  useMultiAccountIdentities: () => ({
    enabled: true,
    groups: identityGroups.current,
    allIdentities: identityGroups.current.flatMap((g) => g.identities),
  }),
  stripCrossAccountIdentityPrefix: (id: string) => {
    const idx = id.indexOf('::');
    return idx === -1
      ? { localAccountId: null, rawId: id }
      : { localAccountId: id.slice(0, idx), rawId: id.slice(idx + 2) };
  },
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: () => undefined,
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = {
    // The identity store only ever holds the ACTIVE account's identities, with
    // the server's raw ids (no namespace).
    identities: [
      { id: 'id-1', email: 'me@work.example', name: 'Me' },
      { id: 'id-1b', email: 'info@work.example', name: 'Info' },
    ],
    defaultIdentityId: 'id-1',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: async () => ({ sent: true }),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/settings-store', () => {
  const state = {
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/plugin-hooks', () => ({
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true },
    onComposeSend: { intercept: async () => true },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
    onBeforeAttachmentUpload: { intercept: async () => true },
    onBeforeBlobUpload: { transform: async (fileId: unknown) => fileId },
    onAfterAttachmentUpload: { emit: () => {} },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
  isExternalAttachmentResult: () => false,
}));

vi.mock('@/lib/plugin-storage', () => ({
  fileStorage: {
    saveFile: async () => {},
    getFile: async () => null,
    deleteFile: async () => {},
  },
}));

vi.mock('@/lib/upload-progress', () => ({
  onUploadProgress: () => () => {},
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
  plainTextBodyHasSignature: () => false,
  plainTextBodyWithoutSignature: (body: string) => body,
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: (email: string) => email }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const ACTIVE_IDENTITIES = [
  { id: 'id-1', email: 'me@work.example', name: 'Me' },
  { id: 'id-1b', email: 'info@work.example', name: 'Info' },
];

const activeClient = {
  uploadBlob: vi.fn(),
  createDraft: vi.fn(),
  hasDelayedSend: () => false,
  getMaxDelayedSend: () => 0,
};

function renderComposer() {
  return render(<EmailComposer onClose={vi.fn()} />);
}

describe('composer From selector with several accounts', () => {
  beforeEach(() => {
    useAuthStore.setState({
      client: activeClient as never,
      activeAccountId: 'acct-1' as never,
      getClientForAccount: (() => undefined) as never,
    });
  });

  afterEach(() => {
    useAuthStore.setState({ client: null, activeAccountId: null as never });
    useIdentityStore.setState({ identities: ACTIVE_IDENTITIES as never });
    identityGroups.current = ALL_GROUPS;
    vi.clearAllMocks();
  });

  it('groups every connected account\'s addresses under the account label', () => {
    const { getByTestId } = renderComposer();

    const select = getByTestId('composer-from') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.querySelectorAll('optgroup')).map((g) => g.label)).toEqual([
      'Work',
      'Personal',
    ]);
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'acct-1::id-1',
      'acct-1::id-1b',
      'acct-2::id-other',
    ]);
  });

  it('defaults to the active account identity by its namespaced id', () => {
    const { getByTestId } = renderComposer();

    const select = getByTestId('composer-from') as HTMLSelectElement;
    expect(select.value).toBe('acct-1::id-1');
  });

  it('keeps an explicitly chosen identity from another account selected', () => {
    const { getByTestId } = render(
      <EmailComposer
        initialData={{
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          showCc: false,
          showBcc: false,
          selectedIdentityId: 'acct-2::id-other',
          subAddressTag: '',
          mode: 'compose',
          draftId: null,
        }}
        onClose={vi.fn()}
      />,
    );

    expect((getByTestId('composer-from') as HTMLSelectElement).value).toBe('acct-2::id-other');
  });

  it('falls back to a listed address when the active account has no identity', () => {
    // Identities still loading, or an account that simply has none: the
    // dropdown can only offer the other account's address, so that is what the
    // composer must treat as the sender - otherwise it shows one address and
    // saves/sends through the active account.
    useIdentityStore.setState({ identities: [] as never });
    identityGroups.current = ALL_GROUPS.filter((g) => g.localAccountId !== 'acct-1');

    const { getByTestId } = renderComposer();

    // A single remaining address renders as text rather than a dropdown.
    expect(getByTestId('composer-from').textContent).toContain('other@example.com');
  });
});
