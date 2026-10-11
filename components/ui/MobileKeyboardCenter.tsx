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
 * Global Mobile Keyboard & Input Centering Manager.
 * When a user taps any input or textarea on mobile/tablet:
 * 1. Tracks `window.visualViewport` so the page / modal scroll container gets
 *    extra bottom breathing room equal to the on-screen keyboard height.
 * 2. Smoothly scrolls the active input to the vertical CENTER of the visible
 *    viewport above the keyboard so it is never covered by the keyboard.
 */
export const MobileKeyboardCenter: React.FC = () => {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let t1: number | undefined;
    let t2: number | undefined;

    const clearTimers = () => {
      if (t1) window.clearTimeout(t1);
      if (t2) window.clearTimeout(t2);
    };

    const centerElementInVisibleViewport = (target: HTMLElement) => {
      if (window.innerWidth >= 1024) return;

      const vv = window.visualViewport;
      const visibleHeight = vv ? vv.height : window.innerHeight;
      const visibleTop = vv ? vv.offsetTop : 0;
      const keyboardHeight = Math.max(0, window.innerHeight - visibleHeight);

      // Ensure bottom padding on body or modal scroll container so inputs near the
      // bottom of the page can physically scroll up to the center of the screen
      const modalScrollBody = target.closest('[data-modal-scroll-body="true"]') as HTMLElement | null;
      if (modalScrollBody) {
        modalScrollBody.style.paddingBottom = `${Math.max(140, keyboardHeight + 48)}px`;
      } else {
        document.body.style.paddingBottom = `${Math.max(180, keyboardHeight + 96)}px`;
      }

      // First pass: standard smooth scroll to center block
      try {
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        });
      } catch {
        target.scrollIntoView();
      }

      // Second pass: fine-tune against visualViewport center (accounts for iOS/Android
      // virtual keyboard overlay where layout viewport height != visualViewport height)
      const rect = target.getBoundingClientRect();
      const elementCenterY = rect.top + rect.height / 2;
      const desiredCenterY = visibleTop + visibleHeight * 0.42;
      const deltaY = elementCenterY - desiredCenterY;

      if (Math.abs(deltaY) > 24) {
        if (modalScrollBody) {
          modalScrollBody.scrollBy({ top: deltaY, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: deltaY, behavior: 'smooth' });
        }
      }
    };

    const handleFocusIn = (e: FocusEvent) => {
      if (window.innerWidth >= 1024) return;
      const target = e.target as Element | null;
      if (!isTextEntryElement(target)) return;

      window.dispatchEvent(new CustomEvent('bale:keyboard-state', { detail: true }));

      clearTimers();
      // Center immediately and again as the mobile keyboard finishes sliding up
      t1 = window.setTimeout(() => centerElementInVisibleViewport(target), 120);
      t2 = window.setTimeout(() => centerElementInVisibleViewport(target), 320);
    };

    const handleFocusOut = () => {
      clearTimers();
      t1 = window.setTimeout(() => {
        const active = document.activeElement;
        if (!isTextEntryElement(active)) {
          document.body.style.paddingBottom = '';
          document
            .querySelectorAll<HTMLElement>('[data-modal-scroll-body="true"]')
            .forEach((el) => {
              el.style.paddingBottom = '';
            });
          window.dispatchEvent(new CustomEvent('bale:keyboard-state', { detail: false }));
        }
      }, 100);
    };

    const handleViewportResize = () => {
      if (window.innerWidth >= 1024) return;
      const active = document.activeElement;
      if (isTextEntryElement(active)) {
        centerElementInVisibleViewport(active);
      }
    };

    window.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('focusout', handleFocusOut, true);
    window.visualViewport?.addEventListener('resize', handleViewportResize);

    return () => {
      clearTimers();
      document.body.style.paddingBottom = '';
      window.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('focusout', handleFocusOut, true);
      window.visualViewport?.removeEventListener('resize', handleViewportResize);
    };
  }, []);

  return null;
};
