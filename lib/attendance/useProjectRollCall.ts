'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadProjectRollCall, type ProjectRollCallSnapshot } from './project-roll-call';

type State = { key: string; status: 'loading' | 'ready' | 'error'; snapshot: ProjectRollCallSnapshot | null };

/** A late response from another user, project, or date cannot become the roster. */
export function useProjectRollCall(userId: string | undefined, projectId: string, date: string, enabled: boolean) {
  const key = JSON.stringify([userId, projectId, date, enabled]);
  const current = useRef(key); current.current = key;
  const generation = useRef(0);
  const [state, setState] = useState<State>({ key: '', status: 'loading', snapshot: null });
  const reload = useCallback(async () => {
    const token = ++generation.current;
    if (!enabled || !userId || !projectId || !date) return;
    setState({ key, status: 'loading', snapshot: null });
    try {
      const snapshot = await loadProjectRollCall(projectId, date);
      if (generation.current === token && current.current === key) setState({ key, status: 'ready', snapshot });
    } catch {
      if (generation.current === token && current.current === key) setState({ key, status: 'error', snapshot: null });
    }
  }, [key, enabled, userId, projectId, date]);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);
  return { ...(state.key === key ? state : { key, status: 'loading' as const, snapshot: null }), reload };
}
