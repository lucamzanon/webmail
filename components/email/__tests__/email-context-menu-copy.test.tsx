import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('../rules-menu', () => ({ RulesContextSubMenu: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));

const { EmailContextMenu } = await import('../email-context-menu');

const rights = { mayAddItems: true } as Mailbox['myRights'];
function mailbox(id: string, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, name: id, role: undefined, parentId: undefined, myRights: rights, ...extra } as unknown as Mailbox;
}

const email = { id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;
const ownMailboxes = [mailbox('inbox', { role: 'inbox', name: 'Inbox' }), mailbox('archive', { role: 'archive', name: 'Archive' })];
const otherMailboxes = [
  mailbox('b-inbox', { role: 'inbox', name: 'Inbox' }),
  mailbox('b-drafts', { role: 'drafts', name: 'Drafts' }),
  mailbox('b-work', { name: 'Work' }),
  mailbox('b-readonly', { name: 'Read only', myRights: { mayAddItems: false } as Mailbox['myRights'] }),
];

function renderMenu(props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  return render(
    <EmailContextMenu
      email={email}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={() => {}}
      menuRef={{ current: null }}
      mailboxes={ownMailboxes}
      selectedMailbox="inbox"
      {...props}
    />,
  );
}

describe('Copy to entry of the message menu', () => {
  it('is hidden without another connected account', () => {
    renderMenu({ onCopyToAccount: vi.fn(), copyTargets: [] });
    expect(screen.queryByTestId('ctx-copy-to')).toBeNull();
  });

  it('lists the writable folders of the other accounts and copies into the picked one', () => {
    const onCopyToAccount = vi.fn();
    renderMenu({
      onCopyToAccount,
      copyTargets: [{ accountId: 'local-B', label: 'bob@example.org', mailboxes: otherMailboxes }],
    });
    fireEvent.mouseEnter(screen.getByTestId('ctx-copy-to').parentElement!);

    expect(screen.getByText('bob@example.org')).toBeTruthy();
    expect(screen.getByTestId('copy-to:local-B:b-inbox')).toBeTruthy();
    expect(screen.getByTestId('copy-to:local-B:b-work')).toBeTruthy();
    expect(screen.queryByTestId('copy-to:local-B:b-drafts')).toBeNull();
    expect(screen.queryByTestId('copy-to:local-B:b-readonly')).toBeNull();

    fireEvent.click(screen.getByTestId('copy-to:local-B:b-work'));
    expect(onCopyToAccount).toHaveBeenCalledWith('local-B', 'b-work');
  });

  it('leaves Move to on the current account', () => {
    renderMenu({
      onCopyToAccount: vi.fn(),
      copyTargets: [{ accountId: 'local-B', label: 'bob@example.org', mailboxes: otherMailboxes }],
    });
    fireEvent.mouseEnter(screen.getByTestId('ctx-move-to').parentElement!);
    expect(screen.getByTestId('move-to:archive')).toBeTruthy();
    expect(screen.queryByTestId('move-to:b-work')).toBeNull();
  });
});
