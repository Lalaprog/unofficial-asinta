'use client';

import React, { useEffect, useState } from 'react';

interface AsintaLoaderProps {
  title?: string;
  subtitle?: string;
  variant?: 'fullscreen' | 'inline';
}

/**
 * Pure, wordless Architectural Isometric & Drafting Loader.
 * Retains the isometric structural box with a gentle drafting-line motion.
 */
export const AsintaLoader: React.FC<AsintaLoaderProps> = ({
  variant = 'fullscreen',
}) => {
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTakingLonger(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  const graphic = (
    <div className="relative w-20 h-20 flex items-center justify-center select-none motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 duration-150">
      <span className="sr-only">Loading…</span>

      {/* Static drafting corners; the box remains the focus, not a spinner. */}
      <svg className="absolute w-20 h-20" viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <path d="M8 28 V8 H28 M72 8 H92 V28 M92 72 V92 H72 M28 92 H8 V72" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M8 28 V8 H28 M72 8 H92 V28 M92 72 V92 H72 M28 92 H8 V72" stroke="#1B4978" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="12 164" className="motion-safe:animate-[archStroke_4s_ease-in-out_infinite]" />
      </svg>

      {/* Inner 3D Isometric Architectural Structure Wireframe */}
      <svg
        className="absolute w-12 h-12"
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Softly pulsing isometric roof plane */}
        <polygon
          points="32,8 54,20.5 32,33 10,20.5"
          fill="#1B4978"
          fillOpacity="0.16"
          className="motion-safe:animate-[pulse_1.6s_ease-in-out_infinite]"
        />
        {/* Left structural elevation plane */}
        <polygon
          points="10,20.5 32,33 32,56 10,43.5"
          fill="#0B1F3A"
          fillOpacity="0.10"
          className="motion-safe:animate-[pulse_1.6s_ease-in-out_0.25s_infinite]"
        />
        {/* Right structural elevation plane */}
        <polygon
          points="54,20.5 32,33 32,56 54,43.5"
          fill="#1B4978"
          fillOpacity="0.22"
          className="motion-safe:animate-[pulse_1.6s_ease-in-out_0.5s_infinite]"
        />

        {/* Animated drafting wireframe strokes */}
        <path
          d="M32 8 L54 20.5 L54 43.5 L32 56 L10 43.5 L10 20.5 Z"
          stroke="#0B1F3A"
          strokeWidth="2"
          strokeLinejoin="round"
          className="motion-safe:animate-[archStroke_1.8s_ease-in-out_infinite]"
        />
        <path
          d="M10 20.5 L32 33 L54 20.5 M32 33 L32 56"
          stroke="#1B4978"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Inner structural column & floor slab lines */}
        <path
          d="M21 26.8 L21 49.8 M43 26.8 L43 49.8 M10 32 L32 44.5 L54 32"
          stroke="#1B4978"
          strokeWidth="1"
          strokeOpacity="0.55"
          strokeDasharray="2 2"
        />
      </svg>
    </div>
  );

  if (variant === 'inline') {
    return <div role="status" aria-live="polite" className="w-full py-10 flex flex-col items-center justify-center gap-3">{graphic}{takingLonger && <p className="text-xs text-ink-secondary">Still loading…</p>}</div>;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] bg-surface/80 backdrop-blur-xs flex flex-col items-center justify-center gap-3"
    >
      {graphic}
      {takingLonger && <p className="text-xs text-ink-secondary">Still loading…</p>}
    </div>
  );
};
