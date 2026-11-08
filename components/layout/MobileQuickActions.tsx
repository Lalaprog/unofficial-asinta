'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, FileText, HandCoins, PencilLine, Receipt, UserPlus } from 'lucide-react';
import type { QuickAction } from '@/lib/mobile/quickActions';

interface Props {
  open: boolean;
  bottom: number | null;
  onClose: () => void;
  onSelect: (action: QuickAction, destination: string) => void;
}

type FanItem = { label: string; icon: typeof Receipt; action?: QuickAction; href?: string; submenu?: boolean; back?: boolean };
const mainActions: FanItem[] = [
  { label: 'Expense', icon: Receipt, submenu: true },
  { label: 'New invoice', icon: FileText, action: 'invoice', href: '/invoices' },
  { label: 'Add worker', icon: UserPlus, action: 'worker', href: '/attendance?tab=workforce' },
  { label: 'Record Bale', icon: HandCoins, action: 'bale', href: '/advances?tab=issued' },
];
const expenseActions: FanItem[] = [
  { label: 'Back', icon: ArrowLeft, back: true },
  { label: 'Scan receipt', icon: Camera, action: 'expense-scan', href: '/expenses' },
  { label: 'Describe', icon: FileText, action: 'expense-describe', href: '/expenses' },
  { label: 'Manual entry', icon: PencilLine, action: 'expense-manual', href: '/expenses' },
];

export function MobileQuickActions({ open, bottom, onClose, onSelect }: Props) {
  const [expenses, setExpenses] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [viewport, setViewport] = useState({ width: 360, height: 700 });
  const firstRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure(); window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!open) { setExpanded(false); setSwitching(false); return; }
    setExpenses(false); setSwitching(false);
    const frame = requestAnimationFrame(() => { setExpanded(true); firstRef.current?.focus({ preventScroll: true }); });
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey); if (timer.current) clearTimeout(timer.current); };
  }, [open, onClose]);

  const changeFan = (next: boolean) => {
    if (switching) return;
    if (reducedMotion()) { setExpenses(next); requestAnimationFrame(() => firstRef.current?.focus({ preventScroll: true })); return; }
    setSwitching(true); setExpanded(false);
    timer.current = setTimeout(() => {
      setExpenses(next); setExpanded(true); setSwitching(false);
      requestAnimationFrame(() => firstRef.current?.focus({ preventScroll: true }));
    }, 260);
  };
  // Keep the outer targets inside narrow screens and above the dock. A taller
  // vertical radius gives the labels enough room even at the shallow endpoints.
  const xRadius = Math.max(0, Math.min(130, (viewport.width - 84) / 2));
  const yRadius = Math.max(76, Math.min(160, viewport.height - (bottom ?? 72) - 60));
  const items = expenses ? expenseActions : mainActions;
  const angles = [150, 110, 70, 30];
  return <>
    <div aria-hidden="true" onClick={onClose} style={{ bottom: bottom ?? 'calc(4.5rem + env(safe-area-inset-bottom))', opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }} className="fixed inset-x-0 top-0 z-40 bg-navy/40 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none lg:hidden" />
    <section id="mobile-quick-actions" ref={(node) => { node?.toggleAttribute('inert', !open || switching); }} role={open ? 'dialog' : undefined} aria-label={expenses ? 'Expense quick actions' : 'Quick actions'} aria-hidden={open ? undefined : true} className="pointer-events-none fixed inset-0 z-50 lg:hidden">
      {items.map((item, index) => {
        const Icon = item.icon;
        const radians = angles[index] * Math.PI / 180;
        const x = Math.cos(radians) * xRadius;
        const y = Math.max(76, Math.sin(radians) * yRadius);
        return <button key={`${expenses}-${item.label}`} ref={index === 0 ? firstRef : undefined} type="button"
          onClick={() => item.submenu ? changeFan(true) : item.back ? changeFan(false) : item.action && item.href && onSelect(item.action, item.href)}
          style={{ left: '50%', bottom: (bottom ?? 72) - 33, transform: `translate(-50%, 50%) translate(${expanded && open ? x : 0}px, ${expanded && open ? -y : 0}px) scale(${expanded && open ? 1 : 0})`, opacity: expanded && open ? 1 : 0, transitionTimingFunction: expanded && open ? 'cubic-bezier(.18,1.45,.4,1)' : 'cubic-bezier(.55,0,1,.45)' }}
          className="pointer-events-auto absolute flex min-h-[68px] w-[78px] flex-col items-center justify-center gap-1 rounded-2xl text-center text-white transition-[transform,opacity] duration-[260ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-brand shadow-lg"><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <span className="rounded-md bg-navy/90 px-1.5 py-0.5 text-[10px] font-bold leading-tight">{item.label}</span>
        </button>;
      })}
    </section>
  </>;
}
