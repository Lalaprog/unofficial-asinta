'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { User, UserRole } from '@/types';
import {
  Compass,
  HardHat,
  Search,
  Mail,
  UserPlus,
  Settings2,
  Trash2,
  KeyRound,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { generateTemporaryPassword } from '@/lib/users/admin';

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const { users, workers, projects, projectSupervisors, refresh } = useDataStore();
  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');

  // Create Account Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('supervisor');
  const [newTempPassword, setNewTempPassword] = useState(() => generateTemporaryPassword());
  const [newAssignedProjects, setNewAssignedProjects] = useState<string[]>([]);
  const [newIncludeInPayroll, setNewIncludeInPayroll] = useState(true);
  const [newPayRate, setNewPayRate] = useState('1200');
  const [newContactNumber, setNewContactNumber] = useState('');
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // One-time provisioned credentials banner
  const [provisionedCredentials, setProvisionedCredentials] = useState<{
    name: string;
    email: string;
    role: UserRole;
    temporaryPassword: string;
    emailSent?: boolean;
    emailNote?: string;
  } | null>(null);
  const [copiedCreds, setCopiedCreds] = useState(false);

  // Edit / Manage Account Modal State (handles role, sites, payroll link, temp password & delete in one modal)
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('supervisor');
  const [editAssignedProjects, setEditAssignedProjects] = useState<string[]>([]);
  const [editIncludeInPayroll, setEditIncludeInPayroll] = useState(false);
  const [editPayRate, setEditPayRate] = useState('1200');
  const [editContactNumber, setEditContactNumber] = useState('');
  const [editResetPassword, setEditResetPassword] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [confirmingDeleteInModal, setConfirmingDeleteInModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const filteredUsers = users.filter((u) => {
    const matchesSearch =
      u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRole = roleFilter === 'all' || u.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const founderCount = users.filter((u) => u.role === 'founder').length;

  const toggleProjectSelection = (
    projectId: string,
    selected: string[],
    setSelected: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    if (selected.includes(projectId)) {
      setSelected(selected.filter((id) => id !== projectId));
    } else {
      setSelected([...selected, projectId]);
    }
  };

  const openCreateModal = () => {
    setNewName('');
    setNewEmail('');
    setNewRole('supervisor');
    setNewTempPassword(generateTemporaryPassword());
    setNewAssignedProjects([]);
    setNewIncludeInPayroll(true);
    setNewPayRate('1200');
    setNewContactNumber('');
    setSendWelcomeEmail(true);
    setIsCreateOpen(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCreating) return;
    setIsCreating(true);
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          role: newRole,
          temporaryPassword: newTempPassword,
          assignedProjectIds: newRole === 'supervisor' ? newAssignedProjects : [],
          includeInPayroll: newRole === 'supervisor' && newIncludeInPayroll,
          payRate: parseFloat(newPayRate) || 1200,
          payRateType: 'daily',
          contactNumber: newContactNumber,
          sendWelcomeEmail,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        showToast('error', result.error || 'Could not create team account.');
        return;
      }

      setProvisionedCredentials({
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
        temporaryPassword: result.temporaryPassword || newTempPassword,
        emailSent: result.emailSent,
        emailNote: result.emailNote,
      });
      setCopiedCreds(false);
      setIsCreateOpen(false);
      showToast('success', `Provisioned ${result.user.name} (${result.user.role}).`);
      await refresh();
    } catch {
      showToast('error', 'Could not contact the BALE server to create the account.');
    } finally {
      setIsCreating(false);
    }
  };

  const openEditModal = (u: User) => {
    const currentAssigned = projectSupervisors
      .filter((ps) => ps.supervisor_id === u.id)
      .map((ps) => ps.project_id);
    const linkedWorker = workers.find((w) => w.id === u.id);

    setEditingUser(u);
    setEditName(u.name);
    setEditRole(u.role);
    setEditAssignedProjects(currentAssigned);
    setEditIncludeInPayroll(linkedWorker ? Boolean(linkedWorker.active) : true);
    setEditPayRate(String(linkedWorker?.pay_rate ?? 1200));
    setEditContactNumber(
      linkedWorker?.contact_number && linkedWorker.contact_number !== '—'
        ? linkedWorker.contact_number
        : ''
    );
    setEditResetPassword('');
    setConfirmingDeleteInModal(false);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser || isUpdating) return;
    setIsUpdating(true);
    try {
      const response = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: editingUser.id,
          name: editName,
          role: editRole,
          assignedProjectIds: editRole === 'supervisor' ? editAssignedProjects : [],
          includeInPayroll: editRole === 'supervisor' && editIncludeInPayroll,
          payRate: parseFloat(editPayRate) || 1200,
          payRateType: 'daily',
          contactNumber: editContactNumber,
          ...(editResetPassword.trim() ? { resetTemporaryPassword: editResetPassword.trim() } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        showToast('error', result.error || 'Could not update team account.');
        return;
      }

      if (result.temporaryPassword) {
        setProvisionedCredentials({
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
          temporaryPassword: result.temporaryPassword,
          emailNote: 'Temporary password reset. User will be required to choose a new personal password on next sign-in.',
        });
        setCopiedCreds(false);
      }

      setEditingUser(null);
      showToast('success', `Updated account settings for ${result.user.name}.`);
      await refresh();
    } catch {
      showToast('error', 'Could not contact the BALE server to update the account.');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!editingUser || isDeleting) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/users?id=${encodeURIComponent(editingUser.id)}`, {
        method: 'DELETE',
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        showToast('error', result.error || 'Could not delete team account.');
        return;
      }

      showToast('success', `Deleted account ${editingUser.name} (${editingUser.email}).`);
      setEditingUser(null);
      setConfirmingDeleteInModal(false);
      await refresh();
    } catch {
      showToast('error', 'Could not contact the BALE server to delete the account.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyCredentials = async () => {
    if (!provisionedCredentials) return;
    const text = [
      `Asinta Architects BALE Login`,
      `Name: ${provisionedCredentials.name}`,
      `Email: ${provisionedCredentials.email}`,
      `Role: ${provisionedCredentials.role}`,
      `Temporary Password: ${provisionedCredentials.temporaryPassword}`,
      `(You will be prompted to set your own personal password on first sign-in.)`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopiedCreds(true);
      showToast('success', 'Temporary credentials copied to clipboard.');
    } catch {
      showToast('error', 'Could not copy automatically — select and copy the password manually.');
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                Firm Administration
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">Postgres Role-Based Access Control</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Team Accounts &amp; Role Security
            </h1>
          </div>

          <Button
            variant="primary"
            size="md"
            onClick={openCreateModal}
            leftIcon={<UserPlus className="w-4 h-4" />}
          >
            Provision Team Account
          </Button>
        </div>

        {/* One-time Provisioned Credentials Banner */}
        {provisionedCredentials && (
          <div
            role="status"
            className="p-5 rounded-3xl bg-status-info-bg/70 border border-status-info/30 space-y-3 text-xs"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center space-x-2">
                <KeyRound className="w-4 h-4 text-navy shrink-0" />
                <span className="font-bold text-navy text-sm">
                  Temporary Credentials for {provisionedCredentials.name} ({provisionedCredentials.email})
                </span>
                <Badge variant={provisionedCredentials.role === 'founder' ? 'navy' : 'warning'} size="sm">
                  {provisionedCredentials.role}
                </Badge>
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCopyCredentials}
                  leftIcon={copiedCreds ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                >
                  {copiedCreds ? 'Copied' : 'Copy Credentials'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setProvisionedCredentials(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>

            <div className="p-3 rounded-2xl bg-white border border-surface-border flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <span className="text-ink-secondary">One-time Temporary Password: </span>
                <code className="font-mono font-bold text-navy text-sm px-2 py-0.5 bg-surface-inset rounded-lg border border-surface-border">
                  {provisionedCredentials.temporaryPassword}
                </code>
              </div>
              <span className="text-[11px] text-ink-muted">
                Mandatory password change is enforced on first sign-in.
              </span>
            </div>

            {provisionedCredentials.emailNote && (
              <div className="text-[11px] text-ink-secondary">
                {provisionedCredentials.emailNote}
              </div>
            )}
          </div>
        )}

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <div className="w-full sm:w-80">
            <Input
              placeholder="Search team member name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />
          </div>

          <div className="w-full sm:w-48">
            <Select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              options={[
                { label: 'All Roles', value: 'all' },
                { label: 'Founders', value: 'founder' },
                { label: 'Supervisors', value: 'supervisor' },
              ]}
            />
          </div>
        </div>

        {/* Users Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 auto-rows-fr">
          {filteredUsers.map((u) => {
            const assignedProjectIds = projectSupervisors
              .filter((ps) => ps.supervisor_id === u.id)
              .map((ps) => ps.project_id);
            const assignedProjects = projects.filter((p) => assignedProjectIds.includes(p.id));
            const linkedWorker = workers.find((w) => w.id === u.id && w.active);
            const isSelf = currentUser?.id === u.id;

            return (
              <div
                key={u.id}
                className="h-full min-w-0 p-6 rounded-3xl bg-white border border-surface-border shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)] space-y-4 flex flex-col justify-between"
              >
                <div className="space-y-4 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center space-x-3.5 min-w-0 flex-1">
                      <div className="w-12 h-12 rounded-2xl bg-surface-inset text-navy flex items-center justify-center font-bold text-base border border-surface-border shadow-[inset_1px_1px_3px_rgba(11,31,58,0.06)] shrink-0">
                        {u.role === 'founder' ? (
                          <Compass className="w-6 h-6 text-navy" />
                        ) : (
                          <HardHat className="w-6 h-6 text-status-warning" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-base text-navy truncate">{u.name}</h3>
                          {isSelf && (
                            <Badge variant="info" size="sm">
                              You
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-ink-secondary flex items-center gap-1.5 mt-0.5 min-w-0">
                          <Mail className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{u.email}</span>
                        </div>
                      </div>
                    </div>

                    <Badge variant={u.role === 'founder' ? 'navy' : 'warning'} size="sm" className="shrink-0">
                      {u.role === 'founder' ? 'Founder' : 'Supervisor'}
                    </Badge>
                  </div>

                  {/* Permissions Description */}
                  <div className="p-3.5 rounded-2xl bg-surface-inset/50 border border-surface-border/70 text-xs space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-ink-secondary">
                        Authorized Scope
                      </span>
                      {linkedWorker && (
                        <Badge variant="success" size="sm">
                          Payroll Roster · ₱{linkedWorker.pay_rate}/day
                        </Badge>
                      )}
                    </div>
                    {u.role === 'founder' ? (
                      <div className="text-ink-secondary">
                        Full administrative &amp; financial access across all studio projects, client invoicing, expenses, payroll, advances, and settings.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="text-ink-secondary">
                          Restricted to field attendance terminal and assigned project sites only. Financial data is masked.
                        </div>
                        <div className="text-xs font-semibold text-navy">
                          Assigned Project Sites ({assignedProjects.length}):
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {assignedProjects.length > 0 ? (
                            assignedProjects.map((p) => (
                              <span
                                key={p.id}
                                className="px-2 py-0.5 rounded-lg bg-white border border-surface-border text-[11px] font-medium text-navy"
                              >
                                {p.name}
                              </span>
                            ))
                          ) : (
                            <span className="text-[11px] text-ink-muted italic">No specific site assigned</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Single clean action button per card */}
                <div className="pt-3 border-t border-surface-border/60 flex items-center justify-between gap-2 text-[11px] text-ink-muted">
                  <span>Registered: {new Date(u.created_at).toLocaleDateString()}</span>

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => openEditModal(u)}
                    leftIcon={<Settings2 className="w-3.5 h-3.5" />}
                  >
                    Manage
                  </Button>
                </div>
              </div>
            );
          })}

          {filteredUsers.length === 0 && (
            <div className="bg-white rounded-3xl border border-surface-border md:col-span-2">
              <EmptyState
                title="No accounts to show"
                description={
                  users.length === 0
                    ? 'No BALE accounts exist yet. Use "Provision Team Account" to add a Founder or Site Supervisor.'
                    : 'No account matches the current search.'
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* PROVISION NEW ACCOUNT MODAL */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Provision New Team Account"
        description="Create a real BALE user with a temporary password. The user will be required to set their own personal password on first sign-in."
        maxWidth="lg"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Full Name"
              placeholder="e.g. Engr. Marco Reyes"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />

            <Input
              label="Real Email Address"
              type="email"
              placeholder="marco@asinta.ph"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
            />
          </div>

          <Select
            label="System Role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as UserRole)}
          >
            <option value="supervisor">Site Supervisor (Field Attendance &amp; Assigned Sites Only)</option>
            <option value="founder">Founder / Super Admin (Full Studio &amp; Financial Ledger)</option>
          </Select>

          {newRole === 'supervisor' && (
            <>
              <div className="space-y-2">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-navy">
                  Assign Project Sites ({newAssignedProjects.length} selected)
                </label>
                <div className="max-h-36 overflow-y-auto p-3 rounded-2xl bg-surface-inset border border-surface-border space-y-2">
                  {projects.length === 0 ? (
                    <div className="text-ink-muted italic">No projects created yet.</div>
                  ) : (
                    projects.map((proj) => {
                      const checked = newAssignedProjects.includes(proj.id);
                      return (
                        <label
                          key={proj.id}
                          className="flex items-center space-x-2.5 cursor-pointer text-xs text-navy font-medium"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              toggleProjectSelection(proj.id, newAssignedProjects, setNewAssignedProjects)
                            }
                            className="rounded border-surface-border text-navy focus:ring-navy"
                          />
                          <span>{proj.name}</span>
                          <span className="text-[11px] text-ink-muted">({proj.location.split(',')[0]})</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-surface-inset/60 border border-surface-border space-y-3">
                <label className="flex items-start space-x-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newIncludeInPayroll}
                    onChange={(e) => setNewIncludeInPayroll(e.target.checked)}
                    className="mt-0.5 rounded border-surface-border text-navy focus:ring-navy"
                  />
                  <div className="space-y-0.5">
                    <div className="font-bold text-navy">
                      Include Supervisor in Daily Attendance &amp; Payroll Engine
                    </div>
                    <div className="text-[11px] text-ink-secondary">
                      Automatically adds this Supervisor to the site workforce roster so their daily attendance, cash advances (bale), and salary are computed in payroll runs.
                    </div>
                  </div>
                </label>

                {newIncludeInPayroll && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <Input
                      label="Daily Rate (PHP ₱)"
                      type="number"
                      min="0"
                      step="50"
                      value={newPayRate}
                      onChange={(e) => setNewPayRate(e.target.value)}
                      required
                    />
                    <Input
                      label="Contact Number"
                      placeholder="0917XXXXXXX"
                      value={newContactNumber}
                      onChange={(e) => setNewContactNumber(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-navy">
              Temporary First-Sign-In Password
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={newTempPassword}
                onChange={(e) => setNewTempPassword(e.target.value)}
                required
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setNewTempPassword(generateTemporaryPassword())}
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                Regenerate
              </Button>
            </div>
            <p className="text-[11px] text-ink-muted">
              At least 8 characters with letters and numbers. When the user signs in with this temporary password, BALE forces them to set their own personal password.
            </p>
          </div>

          <label className="flex items-start space-x-2.5 p-3 rounded-2xl bg-surface-inset/60 border border-surface-border cursor-pointer">
            <input
              type="checkbox"
              checked={sendWelcomeEmail}
              onChange={(e) => setSendWelcomeEmail(e.target.checked)}
              className="mt-0.5 rounded border-surface-border text-navy focus:ring-navy"
            />
            <div className="space-y-0.5">
              <div className="font-bold text-navy">Send welcome email via Firm SMTP (when configured)</div>
              <div className="text-[11px] text-ink-secondary">
                Emails the temporary password to the user&apos;s inbox so logging in also verifies email ownership. You will also get a copyable credential card on screen.
              </div>
            </div>
          </label>

          <div className="pt-3 flex justify-end space-x-2">
            <Button type="button" variant="secondary" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isCreating}>
              Create Team Account
            </Button>
          </div>
        </form>
      </Modal>

      {/* MANAGE ACCOUNT MODAL (Role, Sites, Payroll Inclusion, Temp Password & Delete in one place) */}
      <Modal
        isOpen={Boolean(editingUser)}
        onClose={() => {
          setEditingUser(null);
          setConfirmingDeleteInModal(false);
        }}
        title="Manage Team Account"
        description="Update role permissions, assigned project sites, payroll inclusion, or account access."
        maxWidth="lg"
      >
        {editingUser && (() => {
          const isSelf = currentUser?.id === editingUser.id;
          const isLastFounder = editingUser.role === 'founder' && founderCount <= 1;

          return (
            <form onSubmit={handleEditSubmit} className="space-y-4 text-xs">
              <div className="p-3 rounded-xl bg-surface-inset border border-surface-border flex items-center justify-between">
                <div>
                  <div className="font-bold text-navy">{editingUser.email}</div>
                  <div className="text-[11px] text-ink-secondary">Registered: {new Date(editingUser.created_at).toLocaleDateString()}</div>
                </div>
                <Badge variant={editingUser.role === 'founder' ? 'navy' : 'warning'} size="sm">
                  {editingUser.role}
                </Badge>
              </div>

              <Input
                label="Full Name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
              />

              <Select
                label="System Role"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as UserRole)}
                disabled={isSelf}
              >
                <option value="supervisor">Site Supervisor (Field Attendance &amp; Assigned Sites Only)</option>
                <option value="founder">Founder / Super Admin (Full Studio &amp; Financial Ledger)</option>
              </Select>
              {isSelf && (
                <p className="text-[11px] text-ink-muted">
                  You cannot demote your own active Founder session.
                </p>
              )}

              {editRole === 'supervisor' && (
                <>
                  <div className="space-y-2">
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-navy">
                      Assigned Project Sites ({editAssignedProjects.length} selected)
                    </label>
                    <div className="max-h-36 overflow-y-auto p-3 rounded-2xl bg-surface-inset border border-surface-border space-y-2">
                      {projects.map((proj) => {
                        const checked = editAssignedProjects.includes(proj.id);
                        return (
                          <label
                            key={proj.id}
                            className="flex items-center space-x-2.5 cursor-pointer text-xs text-navy font-medium"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                toggleProjectSelection(proj.id, editAssignedProjects, setEditAssignedProjects)
                              }
                              className="rounded border-surface-border text-navy focus:ring-navy"
                            />
                            <span>{proj.name}</span>
                            <span className="text-[11px] text-ink-muted">({proj.location.split(',')[0]})</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="p-3.5 rounded-2xl bg-surface-inset/60 border border-surface-border space-y-3">
                    <label className="flex items-start space-x-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editIncludeInPayroll}
                        onChange={(e) => setEditIncludeInPayroll(e.target.checked)}
                        className="mt-0.5 rounded border-surface-border text-navy focus:ring-navy"
                      />
                      <div className="space-y-0.5">
                        <div className="font-bold text-navy">
                          Include Supervisor in Daily Attendance &amp; Payroll Engine
                        </div>
                        <div className="text-[11px] text-ink-secondary">
                          Keeps a linked Site Supervisor entry in the workforce roster so their daily attendance, cash advances (bale), and salary are computed in payroll runs.
                        </div>
                      </div>
                    </label>

                    {editIncludeInPayroll && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                        <Input
                          label="Daily Rate (PHP ₱)"
                          type="number"
                          min="0"
                          step="50"
                          value={editPayRate}
                          onChange={(e) => setEditPayRate(e.target.value)}
                          required
                        />
                        <Input
                          label="Contact Number"
                          placeholder="0917XXXXXXX"
                          value={editContactNumber}
                          onChange={(e) => setEditContactNumber(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="space-y-1.5 pt-2 border-t border-surface-border">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-navy">
                  Reset to Temporary Password (Optional)
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Leave blank to keep current password"
                    value={editResetPassword}
                    onChange={(e) => setEditResetPassword(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditResetPassword(generateTemporaryPassword())}
                    leftIcon={<KeyRound className="w-3.5 h-3.5" />}
                  >
                    Generate Temp
                  </Button>
                </div>
                <p className="text-[11px] text-ink-muted">
                  If set, the user&apos;s password is replaced with this temporary password and they will be prompted to set a new personal password on next sign-in.
                </p>
              </div>

              {/* Clean inline account removal section (only for non-self accounts) */}
              {!isSelf && !isLastFounder && (
                <div className="pt-3 border-t border-surface-border">
                  {!confirmingDeleteInModal ? (
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteInModal(true)}
                      className="text-xs font-semibold text-status-danger hover:underline flex items-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove this team account…</span>
                    </button>
                  ) : (
                    <div className="p-3.5 rounded-2xl bg-status-danger-bg border border-status-danger/20 text-status-danger space-y-2.5">
                      <div className="font-bold">
                        Permanently remove {editingUser.name} ({editingUser.email})?
                      </div>
                      <div className="text-[11px]">
                        Revokes login access immediately. Historical attendance logs, payroll, and expenses remain preserved in the ledger.
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          isLoading={isDeleting}
                          onClick={handleDeleteConfirm}
                        >
                          Confirm Remove
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setConfirmingDeleteInModal(false)}
                        >
                          Keep Account
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="pt-3 flex justify-end space-x-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setEditingUser(null);
                    setConfirmingDeleteInModal(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" isLoading={isUpdating}>
                  Save Changes
                </Button>
              </div>
            </form>
          );
        })()}
      </Modal>
    </AppShell>
  );
}
