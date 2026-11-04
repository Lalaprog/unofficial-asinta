// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { mfa: {} } }) }));
import LoginPage from '@/app/page';

afterEach(() => cleanup());

describe('sign-in autocomplete preferences', () => {
  it('requests no browser form history or credential autocomplete on the sign-in form', () => {
    render(React.createElement(LoginPage));
    const email = screen.getByLabelText('Work Email') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(email.autocomplete).toBe('off');
    expect(password.autocomplete).toBe('off');
    expect(email.form?.getAttribute('autocomplete')).toBe('off');
    expect(password.type).toBe('password');
  });
});
