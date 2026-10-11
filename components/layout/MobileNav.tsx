'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { FOUNDER_NAV_GROUPS, SUPERVISOR_NAV_GROUPS } from './Sidebar';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';
import {
  LayoutDashboard,
  FolderKanban,
  Receipt,
  UserCheck,
  UserCog,
  Clock,
  Menu,
  X,
} from 'lucide-react';

interface MobileNavProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
}

export const MobileNav: React.FC<MobileNavProps> = ({ isOpen, onClose, onOpen }) => {
  const pathname = usePathname();
  const { isFounder, user } = useAuth();
  const groups = isFounder ? FOUNDER_NAV_GROUPS : SUPERVISOR_NAV_GROUPS;

  const founderDockItems = [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Projects', href: '/projects', icon: FolderKanban },
    { label: 'Attendance', href: '/attendance', icon: UserCheck },
    { label: 'Billing', href: '/invoices', icon: Receipt },
  ];

  const supervisorDockItems = [
    { label: 'Attendance', href: '/attendance', icon: UserCheck },
    { label: 'Projects', href: '/projects', icon: FolderKanban },
    { label: 'History', href: '/attendance?tab=history', icon: Clock },
    { label: 'Profile', href: '/settings', icon: UserCog },
  ];

  const dockItems = isFounder ? founderDockItems : supervisorDockItems;

  return (
    <>
      {/* Fixed Bottom Thumb Navigation Dock (Mobile / Tablet) */}
      <nav
        aria-label="Mobile quick navigation"
        className="fixed bottom-0 inset-x-0 z-40 lg:hidden bg-white/95 backdrop-blur-md border-t border-surface-border shadow-[0_-2px_12px_rgba(11,31,58,0.06)] px-2 py-1"
      >
        <div
          className={`grid ${
            isFounder ? 'grid-cols-5' : 'grid-cols-4'
          } gap-1 max-w-md mx-auto`}
        >
          {dockItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              pathname === item.href ||
              (item.href !== '/dashboard' &&
                item.href !== '/attendance' &&
                !item.href.includes('?') &&
                pathname.startsWith(item.href));

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-xl text-[10px] font-bold transition-colors truncate ${
                  isActive
                    ? 'text-navy bg-surface-inset/90'
                    : 'text-ink-secondary hover:text-navy'
                }`}
              >
                <Icon className={`w-4 h-4 mb-0.5 ${isActive ? 'text-navy' : 'text-ink-secondary'}`} />
                <span className="truncate max-w-full">{item.label}</span>
              </Link>
            );
          })}

          {isFounder && (
            <button
              type="button"
              onClick={onOpen}
              className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-xl text-[10px] font-bold transition-colors ${
                isOpen ? 'text-navy bg-surface-inset' : 'text-ink-secondary hover:text-navy'
              }`}
            >
              <Menu className="w-4 h-4 mb-0.5" />
              <span>More</span>
            </button>
          )}
        </div>
      </nav>

      {/* Slide-Over Grouped Drawer */}
      {isOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0 bg-navy/50 backdrop-blur-sm animate-in fade-in"
            onClick={onClose}
          />

          <div className="fixed inset-y-0 left-0 w-4/5 max-w-xs bg-white border-r border-surface-border shadow-2xl z-10 flex flex-col p-4 animate-in slide-in-from-left duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-surface-border/80">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-white border border-surface-border flex items-center justify-center shadow-sm">
                  <AsintaEmblem size={20} />
                </div>
                <AsintaWordmark height={16} />
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset"
                aria-label="Close navigation menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-3 px-3 py-2 rounded-xl bg-surface-inset border border-surface-border flex items-center justify-between">
              <span className="text-xs font-bold text-navy truncate">{user?.name}</span>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-ink-secondary shrink-0">
                {isFounder ? 'Founder' : 'Supervisor'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 py-1">
              {groups.map((group) => (
                <div key={group.id} className="space-y-1">
                  <div className="px-2.5 text-[10px] font-bold text-ink-muted uppercase tracking-wider">
                    {group.title}
                  </div>
                  <nav className="space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const isActive =
                        pathname === item.href ||
                        (item.href !== '/dashboard' &&
                          item.href !== '/attendance' &&
                          !item.href.includes('?') &&
                          pathname.startsWith(item.href));

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={onClose}
                          aria-current={isActive ? 'page' : undefined}
                          className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                            isActive
                              ? 'bg-navy text-white shadow-sm'
                              : 'text-ink-secondary hover:text-navy hover:bg-surface-inset'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0">
                            <Icon
                              className={`w-4 h-4 shrink-0 ${
                                isActive ? 'text-white' : 'text-ink-secondary'
                              }`}
                            />
                            <span className="truncate">{item.label}</span>
                          </div>
                          {item.badge && (
                            <span
                              className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                                isActive ? 'bg-white/20 text-white' : 'bg-navy/10 text-navy'
                              }`}
                            >
                              {item.badge}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </nav>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
