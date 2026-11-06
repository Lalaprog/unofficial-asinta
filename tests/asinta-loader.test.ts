// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsintaLoader } from '@/components/ui/AsintaLoader';
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('architectural loader',()=>{
  it('keeps the structural box, avoids a rotating ring and reports a long wait without a fake percentage',()=>{
    vi.useFakeTimers();const {container}=render(React.createElement(AsintaLoader));
    expect(container.querySelector('polygon[points="32,8 54,20.5 32,33 10,20.5"]')).toBeTruthy();
    expect(container.querySelector('[class*="spin"]')).toBeNull();expect(screen.queryByText('Still loading…')).toBeNull();
    act(()=>vi.advanceTimersByTime(8000));expect(screen.getByText('Still loading…')).toBeTruthy();expect(container.textContent).not.toMatch(/\d+%/);
    expect(container.querySelectorAll('[class*="motion-safe:"]').length).toBeGreaterThan(0);
  });
});
