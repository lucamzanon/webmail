"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CheckSquare,
  Loader2,
  Mail,
  MailOpen,
  MoreVertical,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

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

  const client = useAuthStore((s) => s.client);
  const {
    emails,
    mailboxes,
    selectedMailbox,
    selectedEmailIds,
    selectAllEmails,
    clearSelection,
    toggleEmailSelection,
    batchArchive,
    batchDelete,
    batchMarkAsRead,
    batchMarkAsSpam,
    batchUndoSpam,
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

  const selectionCount = selectedEmailIds.size;
  const hasSelection = selectionCount > 0;
  const allSelected = hasSelection && selectionCount === emails.length;

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

  const handleSpam = () =>
    run(async () => {
      if (!client) return;
      const ids = Array.from(selectedEmailIds);
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
          {t("conversations_count", { count: loadedCount, total: totalCount ?? loadedCount })}
        </span>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
