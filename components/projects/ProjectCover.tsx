'use client';
import React, { useEffect, useRef, useState } from 'react';

/** Decorative project image, with the exact original blueprint underneath. */
export function ProjectCover({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setFailed(false); setLoaded(false); setShowLoading(false); }, [projectId]);
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || loaded || failed) { setShowLoading(false); return; }
    const timer = window.setTimeout(() => setShowLoading(true), 700);
    return () => window.clearTimeout(timer);
  }, [visible, loaded, failed]);
  return <div ref={root} className="relative -mx-4 -mt-4 min-h-28 overflow-hidden rounded-t-xl bg-[#0b1f3a] sm:-mx-5 sm:-mt-5" style={{backgroundImage:"url('/brand/project-blueprint.webp')",backgroundSize:'cover',backgroundPosition:'center'}}>
    {!failed && <img src={`/api/projects/${encodeURIComponent(projectId)}/photo`} alt="" loading="lazy" className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`} onLoad={()=>setLoaded(true)} onError={()=>setFailed(true)} />}
    <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-[#0b1f3a]/95 to-[#0b1f3a]/75" />
    <div className="relative flex min-h-28 items-start justify-between gap-3 p-4 pb-6 sm:p-5 sm:pb-7">{children}</div>
    {showLoading && <span role="status" className="absolute bottom-1.5 right-2 rounded bg-navy/70 px-2 py-0.5 text-[10px] text-white">Loading photo…</span>}
  </div>;
}
