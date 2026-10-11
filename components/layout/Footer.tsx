'use client';

import React from 'react';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';

export const Footer: React.FC = () => {
  return (
    <footer className="mt-12 border-t border-surface-border/70 bg-white/60 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Official Asinta Corp. Trademark Lockup */}
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-xl bg-white border border-surface-border shadow-[2px_2px_6px_rgba(11,31,58,0.06),-2px_-2px_6px_rgba(255,255,255,0.95)] flex items-center justify-center shrink-0">
            <AsintaEmblem size={18} />
          </div>
          <div className="flex items-center space-x-2">
            <AsintaWordmark height={14} />
            <span className="text-[10px] font-bold text-ink-muted align-top">TM</span>
          </div>
        </div>

        {/* Studio Attribution & Blueprint Metadata */}
        <div className="flex flex-wrap items-center justify-center sm:justify-end gap-x-2.5 gap-y-1 text-[11px] text-ink-secondary text-center sm:text-right">
          <span className="font-semibold text-navy">
            &copy; {new Date().getFullYear()} Asinta Corp.
          </span>
          <span className="text-surface-border">·</span>
          <span>Architecture &amp; Construction</span>
          <span className="hidden md:inline text-surface-border">·</span>
          <span className="hidden md:inline text-ink-muted font-mono text-[10px]">
            BALE Ledger System
          </span>
        </div>
      </div>
    </footer>
  );
};
