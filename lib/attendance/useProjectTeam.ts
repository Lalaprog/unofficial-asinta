'use client';

import { useEffect, useRef, useState } from 'react';

type TeamState = { key: string; status: 'idle' | 'loading' | 'ready' | 'error'; ids: string[] };

/** Project-scoped team read. A failed or stale read never becomes an empty team. */
export function useProjectTeam(userId: string | undefined, projectId: string, enabled: boolean) {
  const key = JSON.stringify([userId, projectId, enabled]);
  const current = useRef(key); current.current = key;
  const [state, setState] = useState<TeamState>({ key: '', status: 'idle', ids: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !userId || !projectId) return;
    let cancelled = false;
    setState({ key, status: 'loading', ids: [] });
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workers`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.workerIds) || body.workerIds.some((id: unknown) => typeof id !== 'string' || !id) || new Set(body.workerIds).size !== body.workerIds.length) throw new Error('incomplete');
        if (!cancelled && current.current === key) setState({ key, status: 'ready', ids: body.workerIds });
      } catch {
        if (!cancelled && current.current === key) setState({ key, status: 'error', ids: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [key, enabled, userId, projectId, attempt]);
  const visible: TeamState = !enabled || !userId || !projectId
    ? { key, status: 'idle', ids: [] }
    : state.key === key ? state : { key, status: 'loading', ids: [] };
  return { ...visible, reload: () => setAttempt(value => value + 1) };
}
