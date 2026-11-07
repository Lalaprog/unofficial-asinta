import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
import './globals.css';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/lib/auth/authContext';
import { DataStoreProvider } from '@/lib/data/store';
import { SessionWatcher } from '@/components/auth/SessionWatcher';
import { InspectGuard } from '@/components/security/InspectGuard';
import { MobileKeyboardCenter } from '@/components/ui/MobileKeyboardCenter';
import { ReminderListener } from '@/components/reminders/ReminderListener';

export const metadata: Metadata = {
  title: 'BALE | Billing & Advance Ledger Engine — Asinta Architects',
  description:
    'Lightweight AI-integrated service and ledger management platform for Asinta Architects (Batangas, Philippines). Built for project billing, expenses, attendance, and worker advances.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-surface text-ink-primary antialiased min-h-screen">
        <ToastProvider>
          <AuthProvider>
            <DataStoreProvider>
              {children}
              {/* Idle-session warning + honest sign-out notice. Renders nothing
                  when there is no session or while the session is healthy. */}
              <SessionWatcher />
              <ReminderListener />
              <InspectGuard />
              <MobileKeyboardCenter />
            </DataStoreProvider>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
