// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ founder: true }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams('tab=requests') }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/advances/AdvanceRequestsPanel', () => ({ AdvanceRequestsPanel: () => React.createElement('div', null, 'Request panel') }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: state.founder, assurance: 'ready', isLoading: false }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({ isLoaded: true }) }));
import AdvancesPage from '@/app/advances/page';
afterEach(cleanup);
describe('unfinished weekly Bale policy warning', () => {
  it.each([true, false])('is visible for founder=%s without changing the request UI', (founder) => {
    state.founder = founder;
    render(React.createElement(AdvancesPage));
    expect(screen.getByRole('note').textContent).toMatch(/does not yet enforce.*automatic rejection.*Wednesday release.*same-week payroll deduction/);
    expect(screen.getByText('Request panel')).toBeTruthy();
  });
});
