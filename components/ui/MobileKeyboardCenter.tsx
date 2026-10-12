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

const VIEWPORT_SETTLE_DELAY_MS = 180;
const FOCUS_ALIGNMENT_FALLBACK_MS = 800;

function isTextEntryElement(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'select') return false;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return el.isContentEditable;
}

/**
 * Mobile keyboard positioning that waits for the device's actual viewport change
 * rather than guessing when its keyboard animation has finished.
 *
 * It aligns once per focus (never per keystroke), prefers the Visual Viewport API,
 * and keeps the page/footer and fixed role-aware dock out of the keyboard logic.
 */
export const MobileKeyboardCenter: React.FC = () => {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const visualViewport = window.visualViewport;
    let settleTimer: number | undefined;
    let fallbackTimer: number | undefined;
    let blurTimer: number | undefined;
    let pendingTarget: HTMLElement | null = null;
    let lastFocusedTarget: Element | null = null;
    let initialViewportHeight = 0;
    let keyboardViewportResized = false;

    const clearAlignmentTimers = () => {
      if (settleTimer !== undefined) {
        window.clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      if (fallbackTimer !== undefined) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
    };

    const alignTarget = (target: HTMLElement) => {
      if (window.innerWidth >= 1024 || document.activeElement !== target) return;

      const visibleTop = visualViewport?.offsetTop ?? 0;
      const visibleHeight = visualViewport?.height ?? window.innerHeight;
      if (visibleHeight <= 0) return;

      const rect = target.getBoundingClientRect();
      const visibleBottom = visibleTop + visibleHeight;
      const elementCenterY = rect.top + rect.height / 2;
      const clippedByViewport =
        rect.top < visibleTop + 10 || rect.bottom > visibleBottom - 16;
      const tooLow = elementCenterY > visibleTop + visibleHeight * 0.58;

      // Leave top-of-screen search fields alone; only move inputs that are low or covered.
      if (!clippedByViewport && !tooLow) return;

      // Keep a comfortable typing area above the keyboard and fixed mobile dock.
      const desiredCenterY = visibleTop + visibleHeight * 0.42;
      const deltaY = elementCenterY - desiredCenterY;
      if (Math.abs(deltaY) <= 12) return;

      const modalScrollBody = target.closest(
        '[data-modal-scroll-body="true"]'
      ) as HTMLElement | null;
      const behavior: ScrollBehavior = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches
        ? 'auto'
        : 'smooth';

      if (modalScrollBody) {
        modalScrollBody.scrollBy({ top: deltaY, behavior });
      } else {
        window.scrollBy({ top: deltaY, behavior });
      }
    };

    const finishPendingAlignment = () => {
      const target = pendingTarget;
      pendingTarget = null;
      clearAlignmentTimers();
      if (!target || document.activeElement !== target) return;

      // Measure after the browser's own focus/keyboard scroll has settled.
      window.requestAnimationFrame(() => {
        if (document.activeElement === target) alignTarget(target);
      });
    };

    const scheduleSettledAlignment = () => {
      if (!pendingTarget) return;
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(finishPendingAlignment, VIEWPORT_SETTLE_DELAY_MS);
    };

    const handleViewportResize = () => {
      if (!pendingTarget || document.activeElement !== pendingTarget) return;
      const currentHeight = visualViewport?.height ?? window.innerHeight;
      if (initialViewportHeight - currentHeight >= 80) {
        keyboardViewportResized = true;
      }
      if (keyboardViewportResized) scheduleSettledAlignment();
    };

    const handleViewportScroll = () => {
      if (!pendingTarget || document.activeElement !== pendingTarget) return;
      // Ignore focus-induced viewport scrolling until an actual keyboard resize
      // is observed; otherwise an early scroll event could fire before the
      // keyboard finishes opening on some mobile browsers.
      if (keyboardViewportResized) scheduleSettledAlignment();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (window.innerWidth >= 1024) return;
      const target = event.target as Element | null;
      if (!isTextEntryElement(target)) return;
      if (lastFocusedTarget === target) return;

      if (blurTimer !== undefined) {
        window.clearTimeout(blurTimer);
        blurTimer = undefined;
      }
      clearAlignmentTimers();
      lastFocusedTarget = target;
      pendingTarget = target;
      initialViewportHeight = visualViewport?.height ?? window.innerHeight;
      keyboardViewportResized = false;

      // Fallback for browsers/devices that do not report virtual viewport changes.
      fallbackTimer = window.setTimeout(finishPendingAlignment, FOCUS_ALIGNMENT_FALLBACK_MS);
    };

    const handleFocusOut = () => {
      if (blurTimer !== undefined) window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        if (!isTextEntryElement(document.activeElement)) {
          clearAlignmentTimers();
          pendingTarget = null;
          lastFocusedTarget = null;
        }
        blurTimer = undefined;
      }, 80);
    };

    window.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('focusout', handleFocusOut, true);
    window.addEventListener('resize', handleViewportResize, { passive: true });
    visualViewport?.addEventListener('resize', handleViewportResize, { passive: true });
    visualViewport?.addEventListener('scroll', handleViewportScroll, { passive: true });

    return () => {
      clearAlignmentTimers();
      if (blurTimer !== undefined) window.clearTimeout(blurTimer);
      window.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('focusout', handleFocusOut, true);
      window.removeEventListener('resize', handleViewportResize);
      visualViewport?.removeEventListener('resize', handleViewportResize);
      visualViewport?.removeEventListener('scroll', handleViewportScroll);
    };
  }, []);

  return null;
};
