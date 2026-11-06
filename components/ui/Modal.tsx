'use client';

import React, { useEffect, useId, useRef } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '5xl' | 'full';
  /** Use a safe-area-aware sheet for viewport-bound mobile flows. */
  presentation?: 'center' | 'bottom-sheet' | 'top-sheet' | 'workspace';
  /** Use "alertdialog" for messages that must interrupt (e.g. session expiry). */
  role?: 'dialog' | 'alertdialog';
  /** Set false when an accidental outside click must not dismiss (session warnings). */
  dismissOnBackdrop?: boolean;
  /**
   * Set false for alertdialogs where Escape must not silently dismiss the only
   * warning (e.g. the session-expiry dialog, where every dismissal is a choice).
   */
  dismissOnEscape?: boolean;
  /** Set false for alertdialogs whose choices are the only acceptable exits. */
  showCloseButton?: boolean;
}

// A single topmost dialog owns keyboard handling and the scroll lock. This also
// allows a receipt viewer to open above an editing dialog without closing it.
const modalStack: { id: symbol; panel: HTMLElement; returnFocus: HTMLElement | null }[] = [];
let originalBodyOverflow = '';
function syncModalVisibility() {
  modalStack.forEach((item, index) => {
    if (index === modalStack.length - 1) item.panel.removeAttribute('aria-hidden');
    else item.panel.setAttribute('aria-hidden', 'true');
  });
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'textarea:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null
  );
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  maxWidth = 'md',
  presentation = 'center',
  role = 'dialog',
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  showCloseButton = true,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const stackId = useRef(Symbol('modal'));
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dismissOnEscapeRef = useRef(dismissOnEscape);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissOnEscapeRef.current = dismissOnEscape;
  }, [onClose, dismissOnEscape]);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedRef.current = (document.activeElement as HTMLElement) || null;
    const panel = panelRef.current;
    const modalId = stackId.current;
    if (!panel) return;
    if (!modalStack.length) originalBodyOverflow = document.body.style.overflow;
    modalStack.push({ id: modalId, panel, returnFocus: previouslyFocusedRef.current });
    document.body.style.overflow = 'hidden';
    // Move focus before hiding the parent dialog from assistive technology.
    if (modalStack.length > 1) panel.focus({ preventScroll: true });
    syncModalVisibility();

    // Move focus into the dialog ONLY when it first opens (not on every parent
    // re-render while the user is typing in an input inside the modal).
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || modalStack[modalStack.length - 1]?.id !== modalId) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && panel.contains(active)) return;
      // Review workspaces begin with important context. Focusing a field below
      // would scroll past it and may open the mobile keyboard immediately.
      if (presentation === 'workspace') {
        panel.focus({ preventScroll: true });
        return;
      }

      const firstInput = panel.querySelector<HTMLElement>(
        'input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)'
      );
      if (firstInput && firstInput.offsetParent !== null) {
        firstInput.focus();
        return;
      }

      const focusable = getFocusable(panel);
      (focusable[0] || panel).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1]?.id !== modalId) return;
      if (event.key === 'Escape') {
        if (dismissOnEscapeRef.current) onCloseRef.current();
        // Otherwise swallow the key entirely: leaving it unhandled would let a
        // keydown listener further up the tree act on it.
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = getFocusable(panel);

      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? panel.contains(active) : false;

      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      const wasTop = modalStack[modalStack.length - 1]?.id === modalId;
      const index = modalStack.findIndex(item => item.id === modalId);
      const closing = index >= 0 ? modalStack[index] : null;
      const child = index >= 0 ? modalStack[index + 1] : null;
      // If parent and child close together, carry the parent's original focus
      // target forward instead of restoring focus into a removed parent.
      if (closing && child?.returnFocus && closing.panel.contains(child.returnFocus)) child.returnFocus = closing.returnFocus;
      if (index >= 0) modalStack.splice(index, 1);
      syncModalVisibility();
      if (!modalStack.length) document.body.style.overflow = originalBodyOverflow;
      if (wasTop) {
        const target = closing?.returnFocus ?? previouslyFocusedRef.current;
        const remainingTop = modalStack[modalStack.length - 1]?.panel;
        if (target?.isConnected && (!remainingTop || remainingTop.contains(target))) target.focus();
        else remainingTop?.focus({ preventScroll: true });
      }
    };
  }, [isOpen, presentation]);

  if (!isOpen) return null;

  const maxWidthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '5xl': 'max-w-5xl',
    full: 'max-w-4xl',
  };

  return (
    <div
      className={twMerge(
        clsx(
          'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto',
          presentation === 'bottom-sheet' && 'items-end p-0 sm:p-0 lg:items-center lg:p-4',
          presentation === 'workspace' && 'items-end p-0 sm:items-center sm:p-4',
          presentation === 'top-sheet' && 'inset-x-0 top-[calc(4rem+env(safe-area-inset-top))] bottom-0 items-start justify-start p-0 sm:p-0 lg:inset-0 lg:items-center lg:justify-center lg:p-4'
        )
      )}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-navy/40 backdrop-blur-sm animate-backdrop-enter"
        onClick={dismissOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal / Centered Dialog */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={twMerge(
          clsx(
            'relative w-full bg-white rounded-2xl border border-surface-border shadow-2xl z-10 transition-all max-h-[86dvh] flex flex-col my-auto',
            presentation === 'center' && 'animate-dialog-enter',
            presentation === 'workspace' && 'max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] rounded-t-2xl rounded-b-none my-0 pb-[env(safe-area-inset-bottom)] animate-sheet-up sm:max-h-[92dvh] sm:rounded-2xl sm:my-auto sm:pb-0 sm:animate-dialog-enter',
            presentation === 'bottom-sheet' && 'max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] rounded-t-2xl rounded-b-none my-0 pb-[env(safe-area-inset-bottom)] animate-sheet-up lg:max-h-[86dvh] lg:rounded-2xl lg:my-auto lg:pb-0 lg:animate-dialog-enter',
            presentation === 'top-sheet' && 'max-h-[calc(100dvh-4rem-env(safe-area-inset-top))] rounded-t-none rounded-b-2xl my-0 pb-[env(safe-area-inset-bottom)] animate-dropdown-enter lg:max-h-[86dvh] lg:rounded-2xl lg:my-auto lg:pb-0',
            'focus:outline-none',
            maxWidthClasses[maxWidth]
          )
        )}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-surface-border/80 shrink-0">
          <div className="min-w-0 flex-1 pr-3">
            <h3 id={titleId} className="break-words text-base sm:text-lg font-bold text-navy tracking-tight">
              {title}
            </h3>
            {description && (
              <p id={descriptionId} className={clsx("text-xs text-ink-secondary mt-0.5", presentation === 'workspace' && "text-sm")}>
                {description}
              </p>
            )}
          </div>
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-surface-inset hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Content */}
        <div
          data-modal-scroll-body="true"
          className={clsx("p-5 sm:p-6 overflow-y-auto flex-1 overscroll-contain", presentation === 'workspace' && "min-h-0 scroll-pb-6")}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
