'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, FileText, HandCoins, PencilLine, Receipt, UserPlus, X } from 'lucide-react';
import type { QuickAction } from '@/lib/mobile/quickActions';

interface Props {
  open: boolean;
  bottom: number | null;
  onClose: () => void;
  onSelect: (action: QuickAction, destination: string) => void;
}

export function MobileQuickActions({ open, bottom, onClose, onSelect }: Props) {
  const [expenses, setExpenses] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  const buttonClass = 'flex min-h-[4.75rem] flex-col items-center justify-center gap-2 rounded-2xl border border-surface-border bg-surface/60 px-1.5 py-2 text-center text-navy transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-safe:active:scale-95';
  const actions = expenses ? [
    { label: 'Scan receipt', icon: Camera, action: 'expense-scan' as const, href: '/expenses' },
    { label: 'Describe', icon: FileText, action: 'expense-describe' as const, href: '/expenses' },
    { label: 'Manual entry', icon: PencilLine, action: 'expense-manual' as const, href: '/expenses' },
  ] : [
    { label: 'New invoice', icon: Receipt, action: 'invoice' as const, href: '/invoices' },
    { label: 'Add worker', icon: UserPlus, action: 'worker' as const, href: '/attendance?tab=workforce' },
    { label: 'Record Bale', icon: HandCoins, action: 'bale' as const, href: '/advances?tab=issued' },
  ];
  return <>
    <div aria-hidden="true" onClick={onClose} style={{ bottom: bottom ?? 'calc(4.5rem + env(safe-area-inset-bottom))', touchAction: 'none', opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }} className="fixed inset-x-0 top-0 z-40 bg-navy/40 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none lg:hidden" />
    <section id="mobile-quick-actions" ref={(node) => { node?.toggleAttribute('inert', !open); }} role={open ? "dialog" : undefined} aria-hidden={open ? undefined : true} aria-labelledby={open ? "quick-actions-title" : undefined} style={{ bottom: bottom ?? 'calc(4.5rem + env(safe-area-inset-bottom))', maxHeight: `calc(100dvh - ${bottom ?? 72}px - env(safe-area-inset-top) - 1rem)`, transform: open ? 'translateY(0)' : 'translateY(100%)', pointerEvents: open ? 'auto' : 'none' }} className="fixed inset-x-0 z-50 mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border-x border-t border-surface-border bg-white shadow-[0_-8px_30px_rgba(11,31,58,0.12)] motion-safe:animate-launcher-up transition-transform duration-200 ease-out motion-reduce:transition-none lg:hidden">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
        <div className="flex items-center gap-2">
          {expenses && <button type="button" aria-label="Back to quick actions" onClick={() => setExpenses(false)} className="flex h-11 w-11 items-center justify-center rounded-xl text-navy focus-visible:ring-2 focus-visible:ring-brand"><ArrowLeft className="h-5 w-5" /></button>}
          <div><h2 id="quick-actions-title" className="text-sm font-bold text-navy">{expenses ? 'Start an expense' : 'Quick actions'}</h2><p className="text-xs text-ink-secondary">{expenses ? 'Choose how to begin.' : 'Start a task in fewer taps.'}</p></div>
        </div>
        <button ref={closeRef} type="button" aria-label="Close quick actions" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-xl text-ink-secondary focus-visible:ring-2 focus-visible:ring-brand"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
        <div className="grid grid-cols-2 gap-2 min-[380px]:grid-cols-3">
          {!expenses && <button type="button" onClick={() => setExpenses(true)} className={buttonClass}><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand"><Receipt className="h-5 w-5" /></span><span className="text-xs font-semibold">Expense</span></button>}
          {actions.map(({ label, icon: Icon, action, href }) => <button key={action} type="button" onClick={() => onSelect(action, href)} className={buttonClass}><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand"><Icon className="h-5 w-5" aria-hidden="true" /></span><span className="text-xs font-semibold">{label}</span></button>)}
        </div>
      </div>
    </section>
  </>;
}
