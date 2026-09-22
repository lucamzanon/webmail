"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CheckSquare,
  Folder,
  FolderInput,
  Loader2,
  Mail,
  MailOpen,
  MoreVertical,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Tag,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TagPicker } from "@/components/email/tag-picker";
import { keywordsForTagChange, tagsOnEvery } from "@/lib/batch-tagging";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { emailKeyFor } from "@/lib/thread-utils";
import { buildMailboxTree, cn, type MailboxNode } from "@/lib/utils";

interface GmailListToolbarProps {
  /** Loaded conversation count, for the right-hand range readout. */
  loadedCount: number;
  /** Total in the folder, when the server has told us. */
  totalCount?: number;
  onRefresh: () => void;
  isRefreshing?: boolean;
  onMarkFolderRead?: () => void;
  /** Scheduled view: only the per-message scheduling actions make sense. */
  disabled?: boolean;
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  busy,
  className,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid place-items-center w-10 h-10 rounded-full transition-colors shrink-0",
        "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
        className
      )}
    >
      {busy ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <Icon className="w-[18px] h-[18px]" />}
    </button>
  );
}

/**
 * The Gmail skin's single list toolbar. Gmail keeps one row above the list and
 * lets it morph: with nothing selected it offers select-all, refresh and an
 * overflow menu; as soon as a conversation is ticked the batch verbs appear in
 * the same row, rather than in a second bar that pushes the list down.
 */
export function GmailListToolbar({
  loadedCount,
  totalCount,
  onRefresh,
  isRefreshing = false,
  onMarkFolderRead,
  disabled = false,
}: GmailListToolbarProps) {
  const t = useTranslations("email_list");
  const tBatch = useTranslations("email_list.batch_actions");
  const tActions = useTranslations("settings.email_behavior.hover_actions");
  const tFolder = useTranslations("mailbox_context_menu");
  const tMenu = useTranslations("context_menu");
  const tSidebar = useTranslations("sidebar");

  const client = useAuthStore((s) => s.client);
  const {
    emails,
    mailboxes,
    selectedMailbox,
    selectedEmailKeys,
    selectAllEmails,
    clearSelection,
    batchArchive,
    batchDelete,
    batchMarkAsRead,
    batchMarkAsSpam,
    batchUndoSpam,
    batchMoveToMailbox,
    setEmailKeywords,
    isUnifiedView,
    unifiedRole,
  } = useEmailStore();

  const [isProcessing, setIsProcessing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const { menuRef, onKeyDown: onMenuKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: menuOpen,
    onClose: closeMenu,
    triggerRef: menuButtonRef,
  });
  const [moveOpen, setMoveOpen] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const closeMove = useCallback(() => setMoveOpen(false), []);
  const { menuRef: moveRef, onKeyDown: onMoveKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: moveOpen,
    onClose: closeMove,
    triggerRef: moveButtonRef,
  });

  const [tagOpen, setTagOpen] = useState(false);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const closeTag = useCallback(() => setTagOpen(false), []);
  const { menuRef: tagRef, onKeyDown: onTagKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: tagOpen,
    onClose: closeTag,
    triggerRef: tagButtonRef,
  });

  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        menuButtonRef.current?.contains(e.target as Node) ||
        menuRef.current?.contains(e.target as Node)
      ) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen, menuRef]);

  useEffect(() => {
    if (!moveOpen && !tagOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const inside = (button: HTMLElement | null, menu: HTMLElement | null) =>
        button?.contains(e.target as Node) || menu?.contains(e.target as Node);
      if (!inside(moveButtonRef.current, moveRef.current)) setMoveOpen(false);
      if (!inside(tagButtonRef.current, tagRef.current)) setTagOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [moveOpen, tagOpen, moveRef, tagRef]);

  const selectionCount = selectedEmailKeys.size;
  const hasSelection = selectionCount > 0;
  const allSelected = hasSelection
    && emails.length > 0
    && emails.every((email) => selectedEmailKeys.has(emailKeyFor(email)));
  // Optimistic updates and demo fixtures can briefly leave the server total
  // behind the rows already loaded. Never render an impossible "23 of 22".
  const displayedTotal = Math.max(totalCount ?? loadedCount, loadedCount);

  const currentRole = mailboxes.find((mb) => mb.id === selectedMailbox)?.role
    ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined);
  const isInJunk = currentRole === "junk";
  const isInTrash = currentRole === "trash";
  // Marking your own drafts or sent mail as spam is meaningless.
  const spamApplicable = !["sent", "drafts", "scheduled"].includes(currentRole ?? "");

  const run = async (action: () => Promise<void>) => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      await action();
    } finally {
      setTimeout(() => setIsProcessing(false), 400);
    }
  };

  const handleSelectAllToggle = () => {
    if (disabled) return;
    if (hasSelection) {
      if (allSelected) clearSelection();
      else selectAllEmails();
      return;
    }
    if (emails.length > 0) selectAllEmails();
  };

  const handleDelete = () =>
    run(async () => {
      if (!client) return;
      const confirmed = await confirmDialog({
        title: isInTrash ? t("permanent_delete_confirm_title") : tBatch("delete_confirm_title"),
        message: isInTrash
          ? t("permanent_delete_confirm_batch_message", { count: selectionCount })
          : tBatch("delete_confirm_message", { count: selectionCount }),
        confirmText: isInTrash ? t("permanent_delete") : tBatch("delete"),
        variant: "destructive",
      });
      if (!confirmed) return;
      await batchDelete(client, isInTrash);
    });

  const selectedEmails = emails.filter((email) => selectedEmailKeys.has(emailKeyFor(email)));

  // The same targets the row's own context menu offers: somewhere else, that
  // will take a message, and that you are not already in. Drafts is excluded
  // because moving mail into it would make it a draft of yours.
  const moveTargetIds = new Set(
    mailboxes
      .filter((mailbox) =>
        mailbox.id !== selectedMailbox &&
        mailbox.role !== "drafts" &&
        !mailbox.id.startsWith("shared-") &&
        mailbox.myRights?.mayAddItems
      )
      .map((mailbox) => mailbox.id)
  );
  const pruneToTargets = (nodes: MailboxNode[]): MailboxNode[] =>
    nodes.reduce<MailboxNode[]>((kept, node) => {
      const children = pruneToTargets(node.children);
      if (moveTargetIds.has(node.id) || children.length > 0) kept.push({ ...node, children });
      return kept;
    }, []);
  const moveTree = pruneToTargets(buildMailboxTree(mailboxes));

  const renderMoveNodes = (nodes: MailboxNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      const label = localizeMailboxName(node.role, node.name, (key) => tSidebar(`mailboxes.${key}`));
      const isTarget = moveTargetIds.has(node.id);
      return (
        <div key={node.id}>
          {isTarget ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => handleMove(node.id)}
              style={{ paddingInlineStart: `${12 + depth * 16}px` }}
              className="w-full flex items-center gap-2 pe-3 py-2 text-start text-sm hover:bg-muted"
            >
              <Folder className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
              <span className="truncate">{label}</span>
            </button>
          ) : (
            <div
              style={{ paddingInlineStart: `${12 + depth * 16}px` }}
              className="flex items-center gap-2 pe-3 py-2 text-sm text-muted-foreground"
            >
              <Folder className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{label}</span>
            </div>
          )}
          {node.children.length > 0 && renderMoveNodes(node.children, depth + 1)}
        </div>
      );
    });

  const appliedTags = tagsOnEvery(selectedEmails);

  const handleMove = (mailboxId: string) => {
    setMoveOpen(false);
    void run(async () => {
      if (client) await batchMoveToMailbox(client, mailboxId);
    });
  };

  // One request per message, each routed to the account that owns it, because
  // a selection in the unified view spans accounts and a keyword written to
  // the wrong one is accepted and then silently lost.
  const handleToggleTag = (tagId: string) => {
    const apply = !appliedTags.includes(tagId);
    void run(async () => {
      if (!client) return;
      for (const email of selectedEmails) {
        const keywords = keywordsForTagChange(email, tagId, apply);
        if (keywords) await setEmailKeywords(client, email.id, keywords);
      }
    });
  };

  const handleSpam = () =>
    run(async () => {
      if (!client) return;
      const ids = emails
        .filter((email) => selectedEmailKeys.has(emailKeyFor(email)))
        .map((email) => email.id);
      if (isInJunk) await batchUndoSpam(client, ids);
      else await batchMarkAsSpam(client, ids);
    });

  return (
    <div className="flex items-center gap-1 h-12 px-2 shrink-0">
      <button
        type="button"
        role="checkbox"
        aria-checked={allSelected ? true : hasSelection ? "mixed" : false}
        onClick={handleSelectAllToggle}
        disabled={disabled}
        title={
          hasSelection
            ? allSelected
              ? tBatch("clear_selection")
              : tBatch("select_all")
            : tBatch("select")
        }
        className={cn(
          "grid place-items-center w-10 h-10 rounded-full transition-colors shrink-0",
          "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
          hasSelection && "text-primary",
          disabled && "opacity-50 cursor-not-allowed hover:bg-transparent"
        )}
      >
        {hasSelection ? (
          <CheckSquare className="w-[18px] h-[18px]" />
        ) : (
          <Square className="w-[18px] h-[18px]" />
        )}
      </button>

      <ToolbarButton
        icon={RotateCcw}
        label={t("loading")}
        onClick={onRefresh}
        disabled={!client || isRefreshing}
        busy={isRefreshing}
      />

      <div className="relative shrink-0">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={tFolder("mark_folder_read")}
          aria-label={tFolder("mark_folder_read")}
          className={cn(
            "grid place-items-center w-10 h-10 rounded-full transition-colors",
            menuOpen
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          )}
        >
          <MoreVertical className="w-[18px] h-[18px]" />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            onKeyDown={onMenuKeyDown}
            role="menu"
            className="absolute start-0 top-full mt-1 z-50 min-w-56 rounded-lg border border-border bg-popover py-1 shadow-xl"
          >
            <button
              type="button"
              role="menuitem"
              disabled={!onMarkFolderRead}
              onClick={() => {
                setMenuOpen(false);
                onMarkFolderRead?.();
              }}
              className="w-full px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-50"
            >
              {tFolder("mark_folder_read")}
            </button>
          </div>
        )}
      </div>

      {hasSelection && !disabled && (
        <>
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          <ToolbarButton
            icon={Archive}
            label={tActions("archive")}
            onClick={() => run(async () => { if (client) await batchArchive(client); })}
            disabled={isProcessing}
            busy={isProcessing}
          />
          {spamApplicable && (
            <ToolbarButton
              icon={isInJunk ? ShieldCheck : ShieldAlert}
              label={isInJunk ? tActions("not_spam") : tActions("spam")}
              onClick={handleSpam}
              disabled={isProcessing}
            />
          )}
          <ToolbarButton
            icon={Trash2}
            label={tBatch("delete")}
            onClick={handleDelete}
            disabled={isProcessing}
            className="hover:text-red-600 dark:hover:text-red-400"
          />
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          {moveTree.length > 0 && (
            <div className="relative shrink-0">
              <button
                ref={moveButtonRef}
                type="button"
                onClick={() => { setTagOpen(false); setMoveOpen((v) => !v); }}
                aria-haspopup="menu"
                aria-expanded={moveOpen}
                title={tMenu("move_to")}
                aria-label={tMenu("move_to")}
                className={cn(
                  "grid place-items-center w-10 h-10 rounded-full transition-colors",
                  moveOpen
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                )}
              >
                <FolderInput className="w-[18px] h-[18px]" />
              </button>
              {moveOpen && (
                <div
                  ref={moveRef}
                  onKeyDown={onMoveKeyDown}
                  role="menu"
                  aria-label={tMenu("move_to")}
                  className="absolute start-0 top-full mt-1 z-50 min-w-64 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl"
                >
                  {renderMoveNodes(moveTree)}
                </div>
              )}
            </div>
          )}
          <div className="relative shrink-0">
            <button
              ref={tagButtonRef}
              type="button"
              onClick={() => { setMoveOpen(false); setTagOpen((v) => !v); }}
              aria-haspopup="menu"
              aria-expanded={tagOpen}
              title={tMenu("tag")}
              aria-label={tMenu("tag")}
              className={cn(
                "grid place-items-center w-10 h-10 rounded-full transition-colors",
                tagOpen
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              )}
            >
              <Tag className="w-[18px] h-[18px]" />
            </button>
            {tagOpen && (
              <div
                ref={tagRef}
                onKeyDown={onTagKeyDown}
                role="menu"
                aria-label={tMenu("tag")}
                className="absolute start-0 top-full mt-1 z-50 min-w-64 rounded-lg border border-border bg-popover py-1 shadow-xl"
              >
                <TagPicker selectedIds={appliedTags} onToggle={handleToggleTag} />
              </div>
            )}
          </div>
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          <ToolbarButton
            icon={MailOpen}
            label={tBatch("mark_read")}
            onClick={() => run(async () => { if (client) await batchMarkAsRead(client, true); })}
            disabled={isProcessing}
          />
          <ToolbarButton
            icon={Mail}
            label={tBatch("mark_unread")}
            onClick={() => run(async () => { if (client) await batchMarkAsRead(client, false); })}
            disabled={isProcessing}
          />
          <span className="ms-2 text-sm text-muted-foreground truncate">
            {tBatch("selected_messages", { count: selectionCount })}
          </span>
        </>
      )}

      <div className="flex-1 min-w-0" />

      {loadedCount > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums pe-2 shrink-0">
          {t("conversations_count", { count: loadedCount, total: displayedTotal })}
        </span>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
