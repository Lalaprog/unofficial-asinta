'use client';

import React from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import {
  LayoutDashboard, FolderKanban, Receipt, CreditCard, UserCheck, History,
  UserPlus, HandCoins, Banknote, Users, Wrench, MessageSquareShare,
  CalendarClock, Settings, ShieldCheck,
} from 'lucide-react';

const FOUNDER_APP_GRID_SECTIONS = [
  {
    label: 'Studio & Workforce',
    items: [
      { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Projects', href: '/projects', icon: FolderKanban },
      { label: 'Roll Call', href: '/attendance', icon: UserCheck },
      { label: 'History', href: '/attendance?tab=history', icon: History },
      { label: 'Workforce', href: '/attendance?tab=workforce', icon: UserPlus },
      { label: 'Payroll', href: '/payroll', icon: Banknote },
    ],
  },
  {
    label: 'Receivables & Ledger',
    items: [
      { label: 'Invoices', href: '/invoices', icon: Receipt },
      { label: 'Clients', href: '/clients', icon: Users },
      { label: 'Expenses', href: '/expenses', icon: CreditCard },
      { label: 'Worker Bale', href: '/advances', icon: HandCoins },
      { label: 'Reminders', href: '/reminders', icon: CalendarClock },
      { label: 'PhilSMS', href: '/sms', icon: MessageSquareShare },
    ],
  },
  {
    label: 'Equipment & Administration',
    items: [
      { label: 'Tools', href: '/tools', icon: Wrench },
      { label: 'Team', href: '/users', icon: ShieldCheck },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

interface MobileWorkspaceLauncherProps {
  isOpen: boolean;
  onClose: () => void;
  isHrefActive: (href: string) => boolean;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}

/** Same mobile module grid, with a scrollable, keyboard-operable dialog shell. */
export const MobileWorkspaceLauncher: React.FC<MobileWorkspaceLauncherProps> = ({
  isOpen, onClose, isHrefActive, onNavigate,
}) => (
  <Modal isOpen={isOpen} onClose={onClose} title="Workspace Modules"
    description="Choose a module to switch views." presentation="bottom-sheet" maxWidth="lg">
    <div className="space-y-3">
      {FOUNDER_APP_GRID_SECTIONS.map((section) => (
        <section key={section.label} aria-label={section.label}
          className="bg-white rounded-2xl p-2.5 border border-surface-border/80 shadow-xs">
          <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-ink-muted px-1.5 mb-1.5">
            {section.label}
          </h4>
          <div className="grid grid-cols-3 gap-1.5">
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = isHrefActive(item.href);
              return (
                <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                  onClick={(event) => onNavigate(event, item.href)}
                  className={`flex min-h-11 flex-col items-center justify-center py-2 px-1.5 rounded-xl text-center transition-[color,background-color,transform] duration-150 motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                    active ? 'bg-brand text-white' : 'bg-surface/60 text-navy hover:bg-surface-inset'
                  }`}>
                  <Icon aria-hidden="true" className="w-4 h-4 mb-1" />
                  <span className="text-[11px] font-bold break-words max-w-full">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  </Modal>
);
