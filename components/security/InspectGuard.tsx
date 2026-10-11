'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AsintaEmblem } from '@/components/ui/AsintaLogo';

/**
 * Portal-style right-click & DevTools shortcut guard.
 * Blocks contextmenu (outside of text inputs so normal copy/paste in forms still
 * works) and common inspection shortcuts (F12, Ctrl+Shift+I/J/C, Ctrl+U), showing
 * a clean auto-dismissing security card.
 */
export const InspectGuard: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: number | undefined;

    const triggerNotice = () => {
      setVisible(true);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), 2400);
    };

    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      // Allow normal copy/paste inside form inputs & textareas
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      triggerNotice();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isF12 = e.key === 'F12';
      const isInspectCombo =
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (key === 'i' || key === 'j' || key === 'c');
      const isViewSource = (e.ctrlKey || e.metaKey) && key === 'u';

      if (isF12 || isInspectCombo || isViewSource) {
        e.preventDefault();
        triggerNotice();
      }
    };

    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => setVisible(false)}
      className="fixed inset-0 z-[110] bg-navy/25 backdrop-blur-[2px] flex items-center justify-center p-4 animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs rounded-2xl bg-white border border-surface-border shadow-[0_18px_42px_rgba(11,31,58,0.18)] p-5 text-center space-y-3 animate-in zoom-in-95 duration-150"
      >
        <div className="w-12 h-12 rounded-xl bg-surface flex items-center justify-center mx-auto border border-surface-border">
          <AsintaEmblem size={26} />
        </div>
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 text-xs font-bold text-navy">
            <ShieldCheck className="w-3.5 h-3.5 text-[#1B4978]" />
            <span>Protected Workspace</span>
          </div>
          <p className="text-[11px] text-ink-secondary leading-relaxed">
            Browser inspection and context actions are restricted on the Asinta Corp. BALE system.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="w-full py-1.5 rounded-xl bg-navy text-white text-xs font-semibold hover:bg-navy-light transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};
