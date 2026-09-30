import { describe, it, expect } from 'vitest';
import { tagsOnEvery, keywordsForTagChange } from '../batch-tagging';
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from '../thread-utils';
import type { Email } from '../jmap/types';

const email = (keywords: Record<string, boolean>): Email =>
  ({ id: 'e', keywords } as unknown as Email);

const tagged = (...ids: string[]) =>
  email(Object.fromEntries(ids.map((id) => [KEYWORD_PREFIX + id, true])));

describe('tagsOnEvery', () => {
  it('keeps only the tags the whole selection shares', () => {
    expect(tagsOnEvery([tagged('work', 'urgent'), tagged('work')]).sort()).toEqual(['work']);
  });

  it('has nothing to report for an empty selection', () => {
    expect(tagsOnEvery([])).toEqual([]);
  });

  it('counts a tag written in the legacy spelling as the same tag', () => {
    const legacy = email({ [KEYWORD_PREFIX_LEGACY + 'work']: true });
    expect(tagsOnEvery([tagged('work'), legacy])).toEqual(['work']);
  });
});

describe('keywordsForTagChange', () => {
  it('adds the tag in the current spelling, leaving the others alone', () => {
    const next = keywordsForTagChange(tagged('urgent'), 'work', true);
    expect(next).toEqual({
      [KEYWORD_PREFIX + 'urgent']: true,
      [KEYWORD_PREFIX + 'work']: true,
    });
  });

  it('clears both spellings when taking a tag off', () => {
    const both = email({
      [KEYWORD_PREFIX + 'work']: true,
      [KEYWORD_PREFIX_LEGACY + 'work']: true,
    });
    expect(keywordsForTagChange(both, 'work', false)).toEqual({
      [KEYWORD_PREFIX + 'work']: false,
      [KEYWORD_PREFIX_LEGACY + 'work']: false,
    });
  });

  it('asks for no request when the message already agrees', () => {
    expect(keywordsForTagChange(tagged('work'), 'work', true)).toBeNull();
    expect(keywordsForTagChange(tagged('urgent'), 'work', false)).toBeNull();
  });
});
