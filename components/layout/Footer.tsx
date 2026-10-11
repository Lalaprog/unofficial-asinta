'use client';

import React from 'react';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';

/**
 * Global Asinta Corp. Trademark Footer.
 * - Desktop (`lg:`): Slim sticky frosted-glass bar pinned to the bottom of the screen.
 * - Mobile (`< lg`): Static footer at the end of the page scroll (above the bottom nav clearance).
 */
export const Footer: React.FC = () => {
  return (
    <footer className="mt-8 lg:mt-auto lg:sticky lg:bottom-0 lg:z-20 border-t border-surface-border/80 bg-white/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 lg:py-2 flex flex-col sm:flex-row items-center justify-between gap-2">
        {/* Official Asinta Corp. Trademark Lockup */}
        <div className="flex items-center space-x-2.5">
          <div className="w-6 h-6 rounded-lg bg-surface border border-surface-border flex items-center justify-center shrink-0">
            <AsintaEmblem size={14} />
          </div>
          <div className="flex items-center space-x-1.5">
            <AsintaWordmark height={12} />
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
