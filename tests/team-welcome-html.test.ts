import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => ({}) }));
vi.mock('@/lib/auth/serverRole', () => ({ requireFounder: async () => ({ ok: true, userId: 'founder' }) }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({}), isServiceRoleConfigured: () => true }));
vi.mock('@/lib/email/mailer', () => ({ isSmtpConfigured: () => true, sendEmail: mock.send }));
vi.mock('@/lib/users/admin', () => ({
  createTeamAccount: async ({ sendWelcomeMail }: { sendWelcomeMail: (mail: unknown) => Promise<unknown> }) => {
    await sendWelcomeMail({ to: 'test@example.com', name: '<img src=x>', role: 'supervisor', temporaryPassword: 'Pass1<script>' });
    return { status: 201, body: { ok: true } };
  },
  updateTeamAccount: vi.fn(), deleteTeamAccount: vi.fn(),
}));
import { POST } from '@/app/api/users/route';

describe('welcome email HTML', () => {
  it('escapes user-controlled name and temporary password in markup', async () => {
    mock.send.mockResolvedValue({ accepted: true });
    await POST(new NextRequest('http://localhost/api/users', { method: 'POST', body: '{}' }));
    const mail = mock.send.mock.calls[0][0];
    expect(mail.html).toContain('&lt;img src=x&gt;');
    expect(mail.html).toContain('Pass1&lt;script&gt;');
    expect(mail.html).not.toContain('<img src=x>');
    expect(mail.html).not.toContain('Pass1<script>');
  });
});
