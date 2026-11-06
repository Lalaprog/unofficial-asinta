// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsintaLoader } from '@/components/ui/AsintaLoader';
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('architectural loader',()=>{
  it('keeps the structural box, restores the smooth ring and reports a long wait without a fake percentage',()=>{
    vi.useFakeTimers();const {container}=render(React.createElement(AsintaLoader));
    expect(container.querySelector('polygon[points="32,8 54,20.5 32,33 10,20.5"]')).toBeTruthy();
    const ring=container.querySelector('[data-loader-ring]');
    expect(ring?.querySelectorAll('circle')).toHaveLength(2);
    expect(ring?.getAttribute('class')).toContain('motion-safe:animate-[spin_4.5s_linear_infinite]');
    expect(ring?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText('Still loading…')).toBeNull();
    act(()=>vi.advanceTimersByTime(8000));expect(screen.getByText('Still loading…')).toBeTruthy();expect(container.textContent).not.toMatch(/\d+%/);
    expect(container.querySelectorAll('[class*="motion-safe:"]').length).toBeGreaterThan(0);
  });
});
