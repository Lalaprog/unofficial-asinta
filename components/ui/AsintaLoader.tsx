'use client';

import React from 'react';
import { AsintaWordmark } from './AsintaLogo';

interface AsintaLoaderProps {
  title?: string;
  subtitle?: string;
  variant?: 'fullscreen' | 'inline';
}

/**
 * Custom Asinta Corp. Concrete Hollow Block (CHB) architectural loader.
 * Animates the three isometric masonry faces (#1B4978 blue, #A7A9AC concrete grey,
 * and #414042 charcoal) in a smooth staggered pulse with a precision blueprint
 * progress bar.
 */
export const AsintaLoader: React.FC<AsintaLoaderProps> = ({
  title = 'Synchronizing Asinta workspace…',
  subtitle = 'Preparing studio ledger & site records',
  variant = 'fullscreen',
}) => {
  const card = (
    <div className="relative w-full max-w-sm rounded-3xl bg-white/95 backdrop-blur-md border border-surface-border/90 shadow-[12px_12px_32px_rgba(11,31,58,0.10),-8px_-8px_24px_rgba(255,255,255,0.95)] p-7 flex flex-col items-center text-center overflow-hidden animate-in fade-in zoom-in-95 duration-200">
      {/* Subtle blueprint grid accent */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #1B4978 1px, transparent 1px), linear-gradient(to bottom, #1B4978 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />

      {/* Animated CHB Isometric Emblem */}
      <div className="relative w-20 h-20 rounded-2xl bg-surface flex items-center justify-center border border-surface-border shadow-[inset_2px_2px_5px_rgba(11,31,58,0.06),inset_-2px_-2px_5px_rgba(255,255,255,0.95)] mb-5">
        <svg
          width="52"
          height="54"
          viewBox="0 0 240 250"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="drop-shadow-sm"
        >
          {/* Top-Left Isometric Block Face — Architectural Blue */}
          <path
            d="M119 10 L189 51 L159 68 L137 55 L119 65 L141 78 L119 91 L97 78 L78 89 L100 102 L70 119 L0 79 Z"
            fill="#1B4978"
            className="animate-[pulse_1.6s_ease-in-out_infinite]"
          />
          {/* Left Vertical Pillar Face — Concrete Silver-Grey */}
          <path
            d="M0 91 L64 128 L64 246 L0 209 Z"
            fill="#A7A9AC"
            className="animate-[pulse_1.6s_ease-in-out_0.25s_infinite]"
          />
          {/* Right Isometric Stepped Face — Deep Charcoal */}
          <path
            d="M198 57 L238 80 L198 103 L198 175 L154 200 L154 128 L120 148 L120 220 L76 245 L76 128 Z"
            fill="#414042"
            className="animate-[pulse_1.6s_ease-in-out_0.5s_infinite]"
          />
        </svg>
      </div>

      {/* Brand Wordmark */}
      <AsintaWordmark height={18} className="mb-3 opacity-90" />

      {/* Status Title & Subtitle */}
      <div className="space-y-1 relative z-10">
        <h3 className="text-sm font-bold text-navy tracking-tight">{title}</h3>
        <p className="text-xs text-ink-secondary">{subtitle}</p>
      </div>

      {/* Animated Precision Progress Bar */}
      <div className="w-full h-1.5 bg-surface-inset rounded-full overflow-hidden mt-5 relative">
        <div className="h-full w-1/2 bg-gradient-to-r from-[#1B4978] via-navy to-[#1B4978] rounded-full animate-[asintaProgress_1.35s_ease-in-out_infinite]" />
      </div>
    </div>
  );

  if (variant === 'inline') {
    return <div className="w-full py-12 flex items-center justify-center px-4">{card}</div>;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] bg-surface/90 backdrop-blur-sm flex flex-col items-center justify-center p-6"
    >
      {card}
    </div>
  );
};
