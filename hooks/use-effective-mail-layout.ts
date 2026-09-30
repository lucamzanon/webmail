"use client";

import { effectiveMailLayout, useSettingsStore, type MailLayout } from "@/stores/settings-store";

/** The mail layout in force: the saved one, or `focus` under the Gmail skin. */
export function useEffectiveMailLayout(): MailLayout {
  return useSettingsStore((state) => effectiveMailLayout(state.mailLayout, state.uiSkin));
}
