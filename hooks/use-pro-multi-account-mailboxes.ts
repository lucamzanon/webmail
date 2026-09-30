"use client";

import { useEffect } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";

/**
 * Keeps `useEmailStore.accountMailboxes` populated with one entry per
 * connected account while the Pro shell is the active interface. The Pro
 * sidebar reads this cache to render a Thunderbird-style per-account folder
 * tree (see [[project_pro_mode]]). Outside Pro the cache stays empty.
 *
 * The Gmail skin needs the same cache for a different reason: its account
 * popover puts the unread waiting in each account next to that address, and
 * the active login's folder list knows nothing about the others. It is only
 * worth the extra round trips once a second account is connected - with one
 * account the popover has nothing to compare.
 *
 * Refetches whenever the set of connected accounts changes, so adding or
 * removing an account in another tab is reflected without a reload.
 */
export function useProMultiAccountMailboxes(): void {
  const isEmbedded = useIsEmbedded();
  const proInterface = useSettingsStore((s) => s.proInterface);
  const gmailSkin = useSettingsStore((s) => s.uiSkin === "gmail");
  const accounts = useAccountStore((s) => s.accounts);

  useEffect(() => {
    const connected = accounts.filter((a) => a.isConnected);
    if (!proInterface && !isEmbedded && !(gmailSkin && connected.length > 1)) return;
    if (connected.length === 0) return;

    const fetchAccountMailboxes = useEmailStore.getState().fetchAccountMailboxes;
    const getClientForAccount = useAuthStore.getState().getClientForAccount;

    for (const account of connected) {
      const client = getClientForAccount(account.id);
      if (!client) continue;
      void fetchAccountMailboxes(client, account.id);
    }
  }, [proInterface, isEmbedded, gmailSkin, accounts]);
}
