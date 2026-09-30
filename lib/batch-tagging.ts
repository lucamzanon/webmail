import type { Email } from "@/lib/jmap/types";
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY, getEmailTagIds } from "@/lib/thread-utils";

/**
 * Applying a tag to several messages at once is not the single-message toggle
 * repeated: the selection can already be half tagged, and "toggle each" would
 * then take the tag off exactly the messages that have it while putting it on
 * the ones that do not - a no-op with extra round trips.
 *
 * Gmail resolves it the way a tri-state checkbox does: a tag every message
 * carries comes off, anything else goes on. These two functions are that rule,
 * kept out of the toolbar so it can be reasoned about on its own.
 */

/** Tags carried by every message in the selection - the ones a click removes. */
export function tagsOnEvery(emails: Email[]): string[] {
  if (emails.length === 0) return [];
  const [first, ...rest] = emails;
  return getEmailTagIds(first.keywords).filter((tagId) =>
    rest.every((email) => getEmailTagIds(email.keywords).includes(tagId))
  );
}

/**
 * The keyword patch for one message. Both spellings of the tag are cleared
 * when taking it off: a message may carry either, and leaving the other set
 * would read as still tagged. Returns null when the message already agrees,
 * so the caller can skip the request entirely.
 */
export function keywordsForTagChange(
  email: Email,
  tagId: string,
  apply: boolean
): Record<string, boolean> | null {
  const keywords = { ...email.keywords };
  const spellings = [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId];
  const carried = spellings.filter((key) => keywords[key]);

  if (apply) {
    if (carried.length > 0) return null;
    keywords[KEYWORD_PREFIX + tagId] = true;
    return keywords;
  }

  if (carried.length === 0) return null;
  for (const key of carried) keywords[key] = false;
  return keywords;
}
