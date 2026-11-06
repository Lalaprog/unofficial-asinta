'use client';

import React, { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

/** Keeps the editing workspace mounted and the receipt private. */
export function ReceiptPhotoViewer({isOpen, src, onClose}: {isOpen:boolean; src:string | null; onClose:()=>void}) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => { if (isOpen) setZoom(1); }, [isOpen]);
  return <Modal isOpen={isOpen && Boolean(src)} onClose={onClose} title="Receipt photo" description="Zoom in to check the details, then close to return to your expense." maxWidth="5xl" presentation="workspace">
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-secondary">At higher zoom, scroll to move around the photo.</p>
        <div className="flex items-center gap-2"><Button type="button" size="sm" variant="secondary" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}>Zoom out</Button><span className="min-w-12 text-center text-sm tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</span><Button type="button" size="sm" variant="secondary" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.5))}>Zoom in</Button></div>
      </div>
      <div tabIndex={0} aria-label="Receipt photo; scroll when zoomed in" className="max-h-[65dvh] overflow-auto overscroll-contain rounded-xl border border-surface-border bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
        {src && <img src={src} alt="Receipt photo enlarged" style={{width: `${zoom * 100}%`, maxWidth:'none'}} className={zoom === 1 ? 'max-h-[65dvh] object-contain' : 'h-auto'} />}
      </div>
    </div>
  </Modal>;
}
