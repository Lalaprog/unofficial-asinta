'use client';

import { useEffect, useState } from 'react';
import { manilaDateISO } from './manila';

/** Refresh the displayed date across midnight or when returning to the tab. */
export function useManilaToday(): string {
  const [today, setToday] = useState(() => manilaDateISO());

  useEffect(() => {
    const refresh = () => setToday(manilaDateISO());
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return today;
}
