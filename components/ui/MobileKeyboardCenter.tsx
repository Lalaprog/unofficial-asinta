'use client';

import React, { useEffect } from 'react';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isTextEntryElement(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'select') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return el.isContentEditable;
}

/**
 * Global Mobile Keyboard Input Centering Manager.
 * - Only triggers ONCE when an input is newly focused on mobile (`< 1024px`).
 * - Never modifies `document.body.style.paddingBottom` (so the page footer and
 *   layout never shift or climb upward while typing).
 * - Only scrolls if the focused input is in the lower part of the visible
 *   screen (covered by or near the on-screen keyboard), smoothly positioning
 *   it into the center of the visible area above the keyboard.
 */
export const MobileKeyboardCenter: React.FC = () => {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let focusTimer: number | undefined;
    let lastCenteredEl: Element | null = null;

    const clearTimer = () => {
      if (focusTimer) {
        window.clearTimeout(focusTimer);
        focusTimer = undefined;
      }
    };

    const centerIfInLowerScreen = (target: HTMLElement) => {
      if (window.innerWidth >= 1024) return;
      if (document.activeElement !== target) return;

      const vv = window.visualViewport;
      const visibleHeight = vv ? vv.height : window.innerHeight;
      const visibleTop = vv ? vv.offsetTop : 0;

      const rect = target.getBoundingClientRect();
      const elementCenterY = rect.top + rect.height / 2;

      // Target vertical center of the visible area above the keyboard (~44% from top)
      const desiredCenterY = visibleTop + visibleHeight * 0.44;
      // Only scroll if the input is in the LOWER part of the visible screen
      // (below 52% of the visible viewport height or covered by the keyboard).
      // Upper-screen inputs (like top search bars) stay put so the page doesn't jump.
      const lowerThresholdY = visibleTop + visibleHeight * 0.52;

      if (elementCenterY <= lowerThresholdY && rect.bottom <= visibleTop + visibleHeight - 16) {
        return;
      }

      const deltaY = elementCenterY - desiredCenterY;
      if (Math.abs(deltaY) <= 16) return;

      const modalScrollBody = target.closest(
        '[data-modal-scroll-body="true"]'
      ) as HTMLElement | null;

      if (modalScrollBody) {
        modalScrollBody.scrollBy({ top: deltaY, behavior: 'smooth' });
      } else {
        window.scrollBy({ top: deltaY, behavior: 'smooth' });
      }
    };

    const handleFocusIn = (e: FocusEvent) => {
      if (window.innerWidth >= 1024) return;
      const target = e.target as Element | null;
      if (!isTextEntryElement(target)) return;

      // Avoid re-scrolling if the same element is already focused
      if (lastCenteredEl === target) return;
      lastCenteredEl = target;

      clearTimer();
      // Wait once for the mobile virtual keyboard to finish opening, then center if needed
      focusTimer = window.setTimeout(() => {
        centerIfInLowerScreen(target);
      }, 280);
    };

    const handleFocusOut = () => {
      clearTimer();
      window.setTimeout(() => {
        if (!isTextEntryElement(document.activeElement)) {
          lastCenteredEl = null;
        }
      }, 80);
    };

    window.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('focusout', handleFocusOut, true);

    return () => {
      clearTimer();
      window.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('focusout', handleFocusOut, true);
    };
  }, []);

  return null;
};
