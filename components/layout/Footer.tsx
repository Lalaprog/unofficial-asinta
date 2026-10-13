'use client';

import React from 'react';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';

/**
 * Global Asinta Corp. Trademark Footer.
 * - PC (`lg:`): Pinned (`fixed bottom-0 inset-x-0 z-30`) to the bottom edge of the viewport.
 * - Mobile (`< lg`): Static at the bottom of the page scroll (above the mobile bottom nav bar).
 */
export const Footer: React.FC = () => {
  return (
    <footer className="mt-8 pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-0 lg:mt-0 lg:fixed lg:bottom-0 lg:inset-x-0 lg:z-30 border-t border-surface-border/80 bg-white/95 backdrop-blur-md shadow-[0_-2px_10px_rgba(11,31,58,0.03)]">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-3 lg:py-2 flex flex-col sm:flex-row items-center justify-between gap-2">
        {/* Official Asinta Corp. Trademark Lockup */}
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded-lg bg-white border border-surface-border flex items-center justify-center shrink-0">
            <AsintaEmblem size={18} />
          </div>
          <div className="flex items-center space-x-1.5">
            <AsintaWordmark height={15} />
            <span className="text-[9px] font-bold text-ink-muted">TM</span>
          </div>
        </div>

        {/* Studio Attribution */}
        <div className="flex items-center gap-x-2 text-[11px] text-ink-secondary">
          <span className="font-semibold text-navy">
            &copy; {new Date().getFullYear()} Asinta Corp.
          </span>
          <span className="text-surface-border">·</span>
          <span>Architecture &amp; Construction</span>
        </div>
      </div>
    </footer>
  );
};
