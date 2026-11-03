'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ArrowRight, CheckCheck, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { getNotificationTimestamp } from '@/lib/notifications/time';

export interface ActionNotification {
  id: string;
  signature: string;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  variant: 'warning' | 'danger' | 'info' | 'success';
  actionable?: boolean;
  priority?: number;
  dismissOnClick?: boolean;
  notificationIds?: string[];
  /** Only a stored event timestamp belongs here, not Date.now() at render. */
  occurredAt?: string | null;
  /** Groups must identify their newest timestamp as “Latest”. */
  timestampPrefix?: string;
}

interface NotificationsPanelProps {
  open: boolean;
  compact: boolean;
  heading: string;
  items: ActionNotification[];
  dismissedCount: number;
  isRefreshing: boolean;
  anchorRef: React.RefObject<HTMLButtonElement>;
  onClearAll: () => void;
  onRestoreDismissed: () => void;
  onSync: () => void;
  onOpenItem: (item: ActionNotification) => void;
  onDismiss: (item: ActionNotification) => void;
}

function typeLabel(variant: ActionNotification['variant']): string {
  if (variant === 'danger') return 'Urgent';
  if (variant === 'warning') return 'Action';
  if (variant === 'success') return 'Synced';
  return 'Info';
}

/** A small client-only clock; it stops as soon as the panel unmounts. */
function useEventClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return now;
}

const NotificationCard: React.FC<{
  item: ActionNotification;
  now: number | null;
  onOpen: (item: ActionNotification) => void;
  onDismiss: (item: ActionNotification) => void;
}> = ({ item, now, onOpen, onDismiss }) => {
  const timestamp = now === null ? null : getNotificationTimestamp(item.occurredAt, now);
  return (
    <li className="flex items-start gap-1 py-2">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="min-h-11 min-w-0 flex-1 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
      >
        <span className="block break-words text-sm font-semibold leading-snug text-navy">
          {item.title}
        </span>
        <span className="mt-1 block break-words text-xs leading-relaxed text-ink-secondary">
          {item.description}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={item.variant} size="sm">{typeLabel(item.variant)}</Badge>
          {timestamp && (
            <time
              dateTime={timestamp.dateTime}
              title={timestamp.isAheadOfDevice
                ? `${timestamp.absoluteLabel}. This is ahead of your device clock; check the device time.`
                : timestamp.absoluteLabel}
              className="text-[11px] leading-relaxed text-ink-muted"
            >
              {item.timestampPrefix || 'Recorded'}: {timestamp.relativeLabel}
            </time>
          )}
        </span>
        <span className="mt-2 inline-flex min-h-6 items-center gap-1.5 text-xs font-semibold text-brand">
          <span>{item.actionLabel}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDismiss(item)}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-white/80 hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label={`Dismiss ${item.title}`}
        title="Dismiss notification"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );
};

/**
 * Non-modal, bell-anchored on both layouts. Radix keeps the closing surface
 * mounted for its CSS exit animation. There are deliberately no drag/touch
 * handlers: notification scrolling must never become a dismissal gesture.
 */
export const NotificationsPanel: React.FC<NotificationsPanelProps> = ({
  open,
  compact,
  heading,
  items,
  dismissedCount,
  isRefreshing,
  anchorRef,
  onClearAll,
  onRestoreDismissed,
  onSync,
  onOpenItem,
  onDismiss,
}) => {
  const now = useEventClock();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = () => anchorRef.current?.focus();

  useEffect(() => {
    // React 18 does not consistently reflect the boolean inert prop. Set the
    // attribute directly so the closing preview cannot receive focus/clicks.
    panelRef.current?.toggleAttribute('inert', !open);
  }, [open]);

  return (
    <Popover.Portal>
      <Popover.Content
        ref={panelRef}
        id="navbar-notifications-panel"
        role={open ? 'dialog' : undefined}
        aria-hidden={open ? undefined : true}
        aria-modal="false"
        aria-labelledby={open ? 'navbar-notifications-title' : undefined}
        aria-describedby={open ? 'navbar-notifications-description' : undefined}
        side="bottom"
        align="end"
        sideOffset={compact ? 0 : 8}
        collisionPadding={compact ? 0 : 12}
        onEscapeKeyDown={returnFocus}
        onCloseAutoFocus={(event) => {
          // Focus was returned immediately for Escape/Close. Never steal it
          // back from a destination after the exit animation finishes.
          event.preventDefault();
        }}
        className="notification-popover z-50 flex w-screen max-w-none flex-col overflow-hidden rounded-b-2xl border-x-0 border-t-0 border-b border-surface-border/80 bg-white/85 shadow-[0_12px_28px_rgba(11,31,58,0.09)] backdrop-blur-xl outline-none data-[state=closed]:pointer-events-none lg:w-[26rem] lg:max-w-[calc(100vw-1.5rem)] lg:rounded-2xl lg:border lg:bg-white/95"
        style={{
          // Leave the mobile dock visible and usable; the list scrolls inside.
          maxHeight: compact
            ? 'calc(100dvh - 9.25rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))'
            : 'min(70dvh, 34rem)',
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-surface-border/60 px-4 pb-3 pt-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id="navbar-notifications-title" className="break-words text-base font-semibold text-navy">
              {heading}
            </h2>
            <p id="navbar-notifications-description" className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
              Updates for your role and assigned sites.
            </p>
          </div>
          <Popover.Close asChild>
            <button
              type="button"
              onClick={returnFocus}
              aria-label="Close notifications"
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-surface-inset hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </Popover.Close>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-surface-border/60 px-3 py-0.5 sm:px-4">
          <span
            className="inline-flex min-h-11 items-center gap-1.5 px-1 text-[11px] font-medium text-ink-secondary"
            title="Updates refresh with the shared ledger. Use Sync now to request an update."
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-success" />
            Auto-sync
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {items.length > 0 && (
              <button
                type="button"
                onClick={onClearAll}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-surface-inset hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Clear all
              </button>
            )}
            <button
              type="button"
              onClick={onSync}
              disabled={isRefreshing}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-surface-inset hover:text-navy disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              aria-label="Sync notifications now"
              aria-busy={isRefreshing}
              title="Sync now"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-brand' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-3">
          <ul aria-label="Notifications" className="divide-y divide-surface-border/60">
            {items.map((item) => (
              <NotificationCard key={item.id} item={item} now={now} onOpen={onOpenItem} onDismiss={onDismiss} />
            ))}
          </ul>
          {items.length === 0 && (
            <div className="space-y-2 px-4 py-7 text-center">
              <CheckCheck className="mx-auto h-5 w-5 text-status-success" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-ink-secondary">
                All clear — no notifications in the current view.
              </p>
              {dismissedCount > 0 && (
                <button
                  type="button"
                  onClick={onRestoreDismissed}
                  className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[11px] font-semibold text-brand transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Show {dismissedCount} cleared {dismissedCount === 1 ? 'notification' : 'notifications'}
                </button>
              )}
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover.Portal>
  );
};
