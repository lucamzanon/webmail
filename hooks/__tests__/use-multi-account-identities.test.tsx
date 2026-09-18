import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The cross-account From dropdown used to be gated behind the Pro shell
 * (`proInterface || isEmbedded`), so the standard shell offered only the
 * active account's identities and a message composed while reading another
 * account's mail could not be sent from that account's address. Picking the
 * sending address is a multi-account need, not a Pro one: the hook now turns
 * on as soon as a second account is connected, in every shell.
 */

const { accountState, authState, identityState } = vi.hoisted(() => ({
  accountState: {
    accounts: [] as Array<{ id: string; isConnected: boolean; label?: string; email?: string; username?: string }>,
  },
  authState: {
    activeAccountId: 'local-1',
    getClientForAccount: (_id: string) => undefined as unknown,
  },
  identityState: {
    identities: [] as Array<{ id: string; email: string; name?: string }>,
  },
}));

vi.mock('@/stores/account-store', () => {
  const hook = (sel?: (s: typeof accountState) => unknown) =>
    typeof sel === 'function' ? sel(accountState) : accountState;
  hook.getState = () => accountState;
  return { useAccountStore: hook };
});

vi.mock('@/stores/auth-store', () => {
  const hook = (sel?: (s: typeof authState) => unknown) =>
    typeof sel === 'function' ? sel(authState) : authState;
  hook.getState = () => authState;
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const hook = (sel?: (s: typeof identityState) => unknown) =>
    typeof sel === 'function' ? sel(identityState) : identityState;
  hook.getState = () => identityState;
  return { useIdentityStore: hook };
});

import { useMultiAccountIdentities, stripCrossAccountIdentityPrefix } from '@/hooks/use-multi-account-identities';

beforeEach(() => {
  accountState.accounts = [
    { id: 'local-1', isConnected: true, label: 'Work' },
    { id: 'local-2', isConnected: true, label: 'Personal' },
  ];
  authState.activeAccountId = 'local-1';
  authState.getClientForAccount = (id: string) =>
    id === 'local-2'
      ? { getIdentities: async () => [{ id: 'i-2', email: 'me@home.example' }] }
      : undefined;
  identityState.identities = [{ id: 'i-1', email: 'me@work.example', name: 'Me' }];
});

describe('useMultiAccountIdentities', () => {
  it('aggregates every connected account outside the Pro shell', async () => {
    const { result } = renderHook(() => useMultiAccountIdentities());

    expect(result.current.enabled).toBe(true);
    await waitFor(() => expect(result.current.groups).toHaveLength(2));

    expect(result.current.groups.map((g) => g.accountLabel)).toEqual(['Work', 'Personal']);
    // Ids stay namespaced per account so the composer can route send/save
    // through the owning account's client.
    expect(result.current.allIdentities.map((i) => i.id)).toEqual(['local-1::i-1', 'local-2::i-2']);
    expect(stripCrossAccountIdentityPrefix('local-2::i-2')).toEqual({ localAccountId: 'local-2', rawId: 'i-2' });
  });

  it('stays off with a single connected account', () => {
    accountState.accounts = [{ id: 'local-1', isConnected: true, label: 'Work' }];

    const { result } = renderHook(() => useMultiAccountIdentities());

    expect(result.current.enabled).toBe(false);
    expect(result.current.groups).toEqual([]);
    expect(result.current.allIdentities).toEqual([]);
  });
});
