'use client';
import React, { useState } from 'react';

/** Decorative project image, with the exact original blueprint underneath. */
export function ProjectCover({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  return <div className="relative -mx-4 -mt-4 min-h-28 overflow-hidden rounded-t-xl bg-[#0b1f3a] sm:-mx-5 sm:-mt-5" style={{backgroundImage:"url('/brand/project-blueprint.webp')",backgroundSize:'cover',backgroundPosition:'center'}}>
    {!failed && <img src={`/api/projects/${encodeURIComponent(projectId)}/photo`} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={()=>setFailed(true)} />}
    <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-[#0b1f3a]/95 to-[#0b1f3a]/75" />
    <div className="relative flex min-h-28 items-start justify-between gap-3 p-4 pb-6 sm:p-5 sm:pb-7">{children}</div>
  </div>;
}
