'use client';

import React from 'react';

interface AsintaLoaderProps {
  title?: string;
  subtitle?: string;
  variant?: 'fullscreen' | 'inline';
}

/**
 * Custom Asinta Concrete Hollow Block (CHB) architectural loader.
 * Uses only the iconic Asinta CHB emblem (without the wordmark) pulsing
 * smoothly above a precision progress indicator.
 */
export const AsintaLoader: React.FC<AsintaLoaderProps> = ({
  title = 'Synchronizing workspace…',
  subtitle = 'Preparing studio ledger & site records',
  variant = 'fullscreen',
}) => {
  const card = (
    <div className="relative w-full max-w-xs rounded-2xl bg-white/95 backdrop-blur-md border border-surface-border shadow-[0_16px_40px_rgba(11,31,58,0.12)] p-6 flex flex-col items-center text-center overflow-hidden animate-in fade-in zoom-in-95 duration-150">
      {/* Animated Asinta CHB Isometric Emblem Only */}
      <div className="relative w-16 h-16 rounded-2xl bg-surface flex items-center justify-center border border-surface-border/80 mb-4">
        <svg
          width="42"
          height="44"
          viewBox="0 0 240 250"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          {/* Top-Left Isometric Block Face — Architectural Blue */}
          <path
            d="M119 10 L189 51 L159 68 L137 55 L119 65 L141 78 L119 91 L97 78 L78 89 L100 102 L70 119 L0 79 Z"
            fill="#1B4978"
            className="animate-[pulse_1.5s_ease-in-out_infinite]"
          />
          {/* Left Vertical Pillar Face — Concrete Silver-Grey */}
          <path
            d="M0 91 L64 128 L64 246 L0 209 Z"
            fill="#A7A9AC"
            className="animate-[pulse_1.5s_ease-in-out_0.22s_infinite]"
          />
          {/* Right Isometric Stepped Face — Deep Charcoal */}
          <path
            d="M198 57 L238 80 L198 103 L198 175 L154 200 L154 128 L120 148 L120 220 L76 245 L76 128 Z"
            fill="#414042"
            className="animate-[pulse_1.5s_ease-in-out_0.44s_infinite]"
          />
        </svg>
      </div>

      {/* Status Title & Subtitle */}
      <div className="space-y-1 relative z-10">
        <h3 className="text-xs font-bold text-navy tracking-tight">{title}</h3>
        <p className="text-[11px] text-ink-secondary">{subtitle}</p>
      </div>

      {/* Animated Precision Progress Bar */}
      <div className="w-full h-1 bg-surface-inset rounded-full overflow-hidden mt-4 relative">
        <div className="h-full w-1/2 bg-gradient-to-r from-[#1B4978] via-navy to-[#1B4978] rounded-full animate-[asintaProgress_1.25s_ease-in-out_infinite]" />
      </div>
    </div>
  );

  if (variant === 'inline') {
    return <div className="w-full py-10 flex items-center justify-center px-4">{card}</div>;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] bg-surface/85 backdrop-blur-xs flex flex-col items-center justify-center p-6"
    >
      {card}
    </div>
  );
};
