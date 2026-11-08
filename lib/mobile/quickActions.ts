'use client';

import { useEffect, useRef } from 'react';

export type QuickAction = 'invoice' | 'expense-manual' | 'expense-scan' | 'expense-describe' | 'worker' | 'bale';
const KEY = 'asinta:mobile-quick-action';
const EVENT = 'asinta:mobile-quick-action';

/** One-shot handoff; contains no user or financial data. */
export function startQuickAction(action: QuickAction, destination: string, currentPath: string, navigate: (href: string) => void) {
  if (!window.dispatchEvent(new CustomEvent('asinta:quick-leave', { cancelable: true, detail: { destination } }))) return false;
  try { sessionStorage.setItem(KEY, JSON.stringify({ action, destination: destination.split('?')[0], at: Date.now() })); }
  catch { window.alert('Quick actions are unavailable in this browser session. Please open the module using More.'); return false; }
  const target = new URL(destination, window.location.origin);
  if (currentPath === target.pathname) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: action }));
  } else {
    navigate(destination);
  }
  return true;
}

/** The destination consumes the handoff exactly once when it is ready. */
export function useQuickAction(path: string, actions: readonly QuickAction[], ready: boolean, handler: (action: QuickAction) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  const supported = actions.join('|');
  useEffect(() => {
    if (!ready) return;
    const accepted = supported.split('|');
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<QuickAction>).detail;
      if (accepted.includes(action)) {
        try { sessionStorage.removeItem(KEY); } catch { /* ignored */ }
        latest.current(action);
      }
    };
    window.addEventListener(EVENT, onAction);
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) {
        const pending = JSON.parse(raw);
        if (pending.destination === path) {
          sessionStorage.removeItem(KEY);
          if (Date.now() - pending.at >= 0 && Date.now() - pending.at < 120000 && accepted.includes(pending.action)) latest.current(pending.action);
        }
      }
    } catch { /* The ordinary page remains usable if storage is unavailable. */ }
    return () => window.removeEventListener(EVENT, onAction);
  }, [path, supported, ready]);
}
