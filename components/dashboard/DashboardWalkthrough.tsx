'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export const DASHBOARD_GUIDE_EVENT = 'asinta:dashboard-guide';
export const ROLL_CALL_GUIDE_EVENT = 'asinta:roll-call-guide';

const STEPS = [
  { target: 'balances', title: 'Client balances', description: 'See outstanding client balances and overdue invoices. Draft and cancelled invoices are excluded.' },
  { target: 'workforce', title: 'Workforce & pay', description: 'Payroll vouchers are above the divider; Bale requests and issued advances are below it.' },
  { target: 'costs', title: 'Project costs', description: 'See recorded expenses and budget usage. The activity indicator shows today’s spending, or falls back to the last seven days or latest active day.' },
  { target: 'scope', title: 'Project scope', description: 'Choose a project to focus the dashboard figures and follow-ups. Select it again or use Reset to return to all projects.' },
  { target: 'attention', title: 'Needs attention', description: 'Review items that may need a follow-up, including overdue invoices and equipment needing attention. Reminders are sent manually.' },
  { target: 'register', title: 'Project register', description: 'Compare projects, review their recorded costs and open a project for more details.' },
] as const;

type Rectangle = { top: number; left: number; width: number; height: number };

type GuideStep = { target: string; title: string; description: string };
type GuideProps = { eventName: string; label: string; targetAttribute: string; steps: readonly GuideStep[] };

/** An optional, read-only guide. It never starts automatically or changes data. */
export function PageWalkthrough({ eventName, label, targetAttribute, steps }: GuideProps) {
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<Rectangle | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = () => setStep(null);
  const isOpen = step !== null;

  useEffect(() => {
    const open = () => {
      if (!window.matchMedia('(max-width: 1023px)').matches) return;
      returnFocus.current = document.activeElement as HTMLElement;
      setStep(0);
    };
    window.addEventListener(eventName, open);
    return () => window.removeEventListener(eventName, open);
  }, [eventName]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.documentElement.style.overscrollBehaviorY;
    document.documentElement.style.overscrollBehaviorY = 'contain';
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (!buttons.length) return;
      if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === panelRef.current)) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); }
    };
    const media = window.matchMedia('(min-width: 1024px)');
    const onResize = () => { if (media.matches) close(); };
    window.addEventListener('keydown', onKey);
    media.addEventListener('change', onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey);
      media.removeEventListener('change', onResize);
      document.documentElement.style.overscrollBehaviorY = previousOverflow;
    };
  }, [isOpen]); // Keep the same focus and listeners while changing steps.

  useEffect(() => {
    if (step !== null || !returnFocus.current) return;
    const previous = returnFocus.current;
    returnFocus.current = null;
    if (previous.isConnected) previous.focus({ preventScroll: true });
  }, [step]);

  useLayoutEffect(() => {
    if (step === null) { setRect(null); return; }
    const target = document.querySelector<HTMLElement>(`[${targetAttribute}="${steps[step].target}"]`);
    if (!target) { setRect(null); return; }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = Math.max(0, window.scrollY + target.getBoundingClientRect().top - 80);
    window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      const panelTop = panelRef.current?.getBoundingClientRect().top ?? window.innerHeight * 0.6;
      const topEdge = Math.max(0, bounds.top - 5);
      const bottomEdge = Math.min(bounds.bottom + 5, panelTop - 8);
      const left = Math.max(4, bounds.left - 5);
      const right = Math.min(window.innerWidth - 4, bounds.right + 5);
      setRect(bottomEdge > topEdge && right > left ? { top: topEdge, left, width: right - left, height: bottomEdge - topEdge } : null);
    };
    measure();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (panelRef.current) observer?.observe(panelRef.current);
    observer?.observe(target);
    return () => { window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); observer?.disconnect(); };
  }, [step, steps, targetAttribute]);

  if (step === null || typeof document === 'undefined') return null;
  const current = steps[step];
  return createPortal(<div className="fixed inset-0 z-[100] lg:hidden">
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden" style={{ touchAction: 'none', background: rect ? 'transparent' : 'rgba(11,31,58,.68)' }}>
      {rect && <div className="absolute rounded-2xl border-2 border-white/90 motion-safe:transition-[top,left,width,height] motion-safe:duration-200" style={{ ...rect, boxShadow: '0 0 0 200vmax rgba(11,31,58,.68)' }} />}
    </div>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="dashboard-guide-title" aria-describedby="dashboard-guide-description" tabIndex={-1}
      className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto max-h-[48dvh] max-w-lg overflow-y-auto overscroll-contain rounded-2xl bg-white p-4 shadow-2xl outline-none motion-safe:animate-panel-enter">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-[11px] font-bold uppercase tracking-wider text-brand">{label} · {step + 1} of {steps.length}</p>
          <h2 id="dashboard-guide-title" className="mt-1 text-base font-bold text-navy">{current.title}</h2></div>
        <button type="button" onClick={close} aria-label={`Close ${label.toLowerCase()}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-secondary focus-visible:ring-2 focus-visible:ring-brand"><X aria-hidden="true" className="h-5 w-5" /></button>
      </div>
      <p id="dashboard-guide-description" className="mt-2 text-sm leading-relaxed text-ink-secondary" aria-live="polite">{current.description}</p>
      <div className="mt-4 flex items-center justify-between gap-2">
        <button type="button" onClick={close} className="min-h-11 rounded-xl px-3 text-xs font-semibold text-ink-secondary focus-visible:ring-2 focus-visible:ring-brand">Skip</button>
        <div className="flex gap-2">
          {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className="min-h-11 rounded-xl border border-surface-border px-4 text-xs font-semibold text-navy focus-visible:ring-2 focus-visible:ring-brand">Back</button>}
          <button type="button" onClick={() => step === steps.length - 1 ? close() : setStep(step + 1)} className="min-h-11 rounded-xl bg-brand px-4 text-xs font-bold text-white focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">{step === steps.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  </div>, document.body);
}

export function DashboardWalkthrough() {
  return <PageWalkthrough eventName={DASHBOARD_GUIDE_EVENT} label="Dashboard guide" targetAttribute="data-dashboard-guide" steps={STEPS} />;
}
