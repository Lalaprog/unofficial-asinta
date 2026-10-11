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
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
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

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
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
  role = 'dialog',
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  showCloseButton = true,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
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
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog ONLY when it first opens (not on every parent
    // re-render while the user is typing in an input inside the modal).
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && panel.contains(active)) return;

      const firstInput = panel.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
      );
      if (firstInput && firstInput.offsetParent !== null) {
        firstInput.focus();
        return;
      }

      const focusable = getFocusable(panel);
      (focusable[0] || panel).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
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
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', handleKeyDown);
      // Return focus to whatever opened the dialog.
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const maxWidthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    full: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-navy/40 backdrop-blur-sm transition-opacity animate-in fade-in"
        onClick={dismissOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal / Bottom sheet */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={twMerge(
          clsx(
            'relative w-full bg-white rounded-t-3xl sm:rounded-2xl border border-surface-border shadow-2xl z-10 transition-all max-h-[92vh] flex flex-col',
            'animate-in slide-in-from-bottom sm:zoom-in-95 duration-200',
            'focus:outline-none',
            maxWidthClasses[maxWidth]
          )
        )}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        {/* Mobile handle indicator */}
        <div className="w-12 h-1.5 bg-slate-300 rounded-full mx-auto mt-3 sm:hidden" />

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border/80">
          <div>
            <h3 id={titleId} className="text-base sm:text-lg font-bold text-navy tracking-tight">
              {title}
            </h3>
            {description && (
              <p id={descriptionId} className="text-xs text-ink-secondary mt-0.5">
                {description}
              </p>
            )}
          </div>
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="p-1.5 rounded-xl text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
};
