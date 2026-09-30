import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Under the Gmail skin the sidebar is one flat list: inbox, sent and drafts,
// then a single "More" that reveals the folders you made, the shared ones and
// the labels. Outside the skin the "Folders" / "Tags" sections stay as they
// are, headings and all.

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false }),
}));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({
  useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }),
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));

const { Sidebar } = await import('../sidebar');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useUIStore } = await import('@/stores/ui-store');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 0, myRights: { mayAddItems: true } },
  { id: 'sent', name: 'Sent', role: 'sent', parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 1, myRights: { mayAddItems: true } },
  { id: 'drafts', name: 'Drafts', role: 'drafts', parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 2, myRights: { mayAddItems: true } },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 3, myRights: { mayAddItems: true } },
  { id: 'receipts', name: 'Receipts', parentId: null, totalEmails: 0, unreadEmails: 0, sortOrder: 4, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

/** Rows carry their untranslated folder name; the visible label is localised. */
const folderRow = (name: string) => document.querySelector(`[data-folder-name="${name}"]`);

describe('Sidebar under the Gmail skin', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false } as never);
    useSettingsStore.setState({
      emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }],
      enableUnifiedMailbox: false,
      hideAccountSwitcher: true,
    } as never);
  });

  it('drops the Folders heading and holds the rest behind More', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" gmailShell />);

    expect(screen.queryByText('folders')).toBeNull();
    expect(screen.getByText('show_more')).toBeInTheDocument();
    expect(folderRow('Receipts')).toBeNull();
    expect(folderRow('Trash')).toBeNull();
    // The labels heading goes with them: Gmail shows it only once expanded.
    expect(screen.queryByText('tags')).toBeNull();
  });

  it('keeps the places mail actually goes in view', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" gmailShell />);

    expect(folderRow('Inbox')).not.toBeNull();
    expect(folderRow('Sent')).not.toBeNull();
    expect(folderRow('Drafts')).not.toBeNull();
  });

  it('reveals the folders and the labels together, and takes them back', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" gmailShell />);

    fireEvent.click(screen.getByText('show_more'));
    expect(folderRow('Receipts')).not.toBeNull();
    expect(folderRow('Trash')).not.toBeNull();
    expect(screen.getByText('tags')).toBeInTheDocument();

    fireEvent.click(screen.getByText('show_fewer'));
    expect(folderRow('Receipts')).toBeNull();
  });

  it('leaves the default skin its sections and every folder', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    expect(screen.getByText('folders')).toBeInTheDocument();
    expect(screen.queryByText('show_more')).toBeNull();
    expect(folderRow('Receipts')).not.toBeNull();
    expect(screen.getByText('tags')).toBeInTheDocument();
  });
});

describe('Sidebar collapsed rail under the Gmail skin', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: true } as never);
    useSettingsStore.setState({ emailKeywords: [], hideAccountSwitcher: true } as never);
  });

  it('peeks the full list out on hover and puts it away again', () => {
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" gmailShell />);
    const rail = container.firstElementChild as HTMLElement;

    expect(rail).not.toHaveAttribute('data-skin-rail-peek');

    fireEvent.mouseEnter(rail);
    expect(rail).toHaveAttribute('data-skin-rail-peek');
    // Peeking means the list is legible, i.e. no longer icon-only.
    expect(screen.getByText('show_more')).toBeInTheDocument();

    fireEvent.mouseLeave(rail);
    expect(rail).not.toHaveAttribute('data-skin-rail-peek');
  });

  it('does not peek outside the skin', () => {
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const rail = container.firstElementChild as HTMLElement;

    fireEvent.mouseEnter(rail);
    expect(rail).not.toHaveAttribute('data-skin-rail-peek');
  });
});
