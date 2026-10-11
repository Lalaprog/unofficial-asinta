'use client';

import React from 'react';

interface AsintaEmblemProps {
  className?: string;
  size?: number;
  monochrome?: boolean;
}

/**
 * Official Asinta Architects Concrete Hollow Block (CHB) Emblem.
 * Represents "asinta" (masonry wall / true alignment).
 */
export const AsintaEmblem: React.FC<AsintaEmblemProps> = ({
  className = '',
  size = 28,
  monochrome = false,
}) => {
  const width = Math.round(size * (352 / 658));
  const height = size;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 352 658"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Top-Left Grey CHB Flange */}
      <path
        d="M0 0H52C64.15 0 74 9.85 74 22V48C74 92 86 118 106 134C56 136 18 168 0 222V0Z"
        fill={monochrome ? 'currentColor' : '#A7A9AC'}
        opacity={monochrome ? 0.55 : 1}
      />
      {/* Top-Right Grey CHB Flange */}
      <path
        d="M352 66H300C287.85 66 278 75.85 278 88V114C278 158 266 184 246 200C296 202 334 234 352 288V66Z"
        fill={monochrome ? 'currentColor' : '#A7A9AC'}
        opacity={monochrome ? 0.55 : 1}
      />
      {/* Left Blue CHB Block */}
      <path
        d="M112 169H212L201 236H134C102 236 78 260 78 292V336C78 368 102 392 134 392H166L154 466H122C94 466 74 486 74 514V543C74 555.15 64.15 565 52 565H0V281C0 214 50 169 112 169Z"
        fill={monochrome ? 'currentColor' : '#1B4978'}
      />
      {/* Right Charcoal CHB Block */}
      <path
        d="M201 204H240C302 204 352 249 352 316V658H300C287.85 658 278 648.15 278 636V580C278 552 258 532 230 532H142L154 466H218C250 466 274 442 274 410V336C274 304 250 280 218 280H189L201 204Z"
        fill={monochrome ? 'currentColor' : '#414042'}
        opacity={monochrome ? 0.8 : 1}
      />
    </svg>
  );
};

interface AsintaWordmarkProps {
  className?: string;
  height?: number;
}

/**
 * Official "asinta corp." wordmark with the grey 'i' and vertical 'corp.'
 */
export const AsintaWordmark: React.FC<AsintaWordmarkProps> = ({
  className = '',
  height = 24,
}) => {
  const width = Math.round(height * (980 / 310));
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 980 310"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Asinta Corp."
    >
      {/* 'a' */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M108 82C48 82 4 128 4 190C4 252 48 298 108 298C136 298 159 286 173 267V293H225V87H173V113C159 94 136 82 108 82ZM115 130C148 130 173 155 173 190C173 225 148 250 115 250C82 250 57 225 57 190C57 155 82 130 115 130Z"
        fill="#21374B"
      />
      {/* 's' */}
      <path
        d="M308 298C354 298 386 272 386 233C386 198 360 182 321 171L299 165C282 160 273 153 273 142C273 130 284 122 302 122C321 122 336 131 344 146L382 121C368 96 340 82 302 82C258 82 225 108 225 145C225 179 249 196 289 207L311 213C329 218 337 225 337 237C337 250 324 258 306 258C283 258 266 247 257 229L217 253C231 282 264 298 308 298Z"
        fill="#21374B"
      />
      {/* 'i' dot + stem */}
      <circle cx="404" cy="40" r="34" fill="#8B8E90" />
      <rect x="377" y="87" width="54" height="206" fill="#8B8E90" />
      {/* 'n' */}
      <path
        d="M431 293H485V178C485 147 503 129 530 129C556 129 572 146 572 176V293H626V165C626 114 594 82 547 82C518 82 496 94 483 113V87H431V293Z"
        fill="#21374B"
      />
      {/* 't' */}
      <path
        d="M626 133H650V293H704V133H736V87H704V12H650V87H626V133Z"
        fill="#21374B"
      />
      {/* 'a' */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M822 82C762 82 718 128 718 190C718 252 762 298 822 298C850 298 873 286 887 267V293H939V87H887V113C873 94 850 82 822 82ZM829 130C862 130 887 155 887 190C887 225 862 250 829 250C796 250 771 225 771 190C771 155 796 130 829 130Z"
        fill="#21374B"
      />
      {/* vertical 'corp.' */}
      <text
        x="972"
        y="293"
        transform="rotate(-90 972 293)"
        fill="#21374B"
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="54"
        fontWeight="400"
        letterSpacing="2"
      >
        corp.
      </text>
    </svg>
  );
};
