'use client';

import { useEffect, useRef, useState } from 'react';

export type BaleSiteWorker = { id: string; name: string; position: string };
type State = { key: string; status: 'idle' | 'loading' | 'ready' | 'error'; workers: BaleSiteWorker[]; someDetailsUnavailable: boolean };

/** Site-scoped picker data. An unsuccessful read is never presented as an empty team. */
export function useBaleProjectWorkers(userId: string | undefined, projectId: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([userId, projectId, enabled, attempt]);
  const current = useRef(key); current.current = key;
  const [state, setState] = useState<State>({ key: '', status: 'idle', workers: [], someDetailsUnavailable: false });
  useEffect(() => {
    if (!enabled || !userId || !projectId) {
      setState({ key, status: 'idle', workers: [], someDetailsUnavailable: false });
      return;
    }
    let cancelled = false;
    setState({ key, status: 'loading', workers: [], someDetailsUnavailable: false });
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workers?view=bale`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.workers) || typeof body.someDetailsUnavailable !== 'boolean' || body.workers.some((worker: unknown) => {
          if (!worker || typeof worker !== 'object') return true;
          const row = worker as Record<string, unknown>;
          return typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || typeof row.position !== 'string';
        }) || new Set(body.workers.map((worker: BaleSiteWorker) => worker.id)).size !== body.workers.length) throw new Error('incomplete');
        if (!cancelled && current.current === key) setState({ key, status: 'ready', workers: body.workers, someDetailsUnavailable: body.someDetailsUnavailable });
      } catch {
        if (!cancelled && current.current === key) setState({ key, status: 'error', workers: [], someDetailsUnavailable: false });
      }
    })();
    return () => { cancelled = true; };
  }, [key, enabled, userId, projectId]);
  const visible: State = !enabled || !userId || !projectId
    ? { key, status: 'idle', workers: [], someDetailsUnavailable: false }
    : state.key === key ? state : { key, status: 'loading', workers: [], someDetailsUnavailable: false };
  return { ...visible, reload: () => setAttempt((value) => value + 1) };
}
