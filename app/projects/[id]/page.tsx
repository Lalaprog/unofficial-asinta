'use client';

import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import {
  ArrowLeft,
  Calendar,
  MapPin,
  Wrench,
  Plus,
  Trash2,
  Edit2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ProjectStatus } from '@/types';
import { formatPesoCompact, formatPeso } from '@/lib/email/format';
import { getBudgetSummary } from '@/lib/projects/budgetSummary';
import { validateProjectForm } from '@/lib/projects/form';
import { useToast } from '@/components/ui/Toast';
import { ProjectWorkforceLogs } from '@/components/projects/ProjectWorkforceLogs';
import { ProjectPhotoManager } from '@/components/projects/ProjectPhotoManager';
import { ProjectWorkers } from '@/components/projects/ProjectWorkers';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const { isFounder } = useAuth();
  const { showToast } = useToast();
  const {
    projects,
    clients,
    invoices,
    expenses,
    tools,
    attendance,
    workers,
    users,
    projectSupervisors,
    updateProject,
    deleteProject,
  } = useDataStore();

  const project = projects.find((p) => p.id === id);
  const client = clients.find((c) => c.id === project?.client_id);
  const projInvoices = invoices.filter((i) => i.project_id === id);
  const projExpenses = expenses.filter((e) => e.project_id === id);
  const projTools = tools.filter((t) => t.project_id === id);
  const projAttendance = attendance.filter((a) => a.project_id === id);

  // Assigned supervisors
  const assignedSupervisorIds = projectSupervisors
    .filter((ps) => ps.project_id === id)
    .map((ps) => ps.supervisor_id);
  const assignedSupervisors = users.filter((u) => assignedSupervisorIds.includes(u.id));

  const [activeTab, setActiveTab] = useState<'overview' | 'invoices' | 'expenses' | 'tools' | 'attendance' | 'workers'>('overview');
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showFormErrors, setShowFormErrors] = useState(false);
  const saveLock = React.useRef(false);
  const deleteLock = React.useRef(false);
  const [editFormData, setEditFormData] = useState({
    name: project?.name || '',
    location: project?.location || '',
    budget_estimate: project?.budget_estimate != null ? String(project.budget_estimate) : '',
    status: (project?.status || 'active') as ProjectStatus,
    start_date: project?.start_date || '',
    target_completion_date: project?.target_completion_date || '',
  });

  if (!project) {
    return (
      <AppShell>
        <div className="p-8 text-center space-y-4">
          <p className="text-navy font-bold">Project not found</p>
          <Link href="/projects">
            <Button variant="secondary">Back to Projects</Button>
          </Link>
        </div>
      </AppShell>
    );
  }

  const formatPHP = formatPesoCompact;

  const totalInvoiced = projInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const totalCollected = projInvoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);
  const totalExpenses = projExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const budget = getBudgetSummary(Number(project.budget_estimate), totalExpenses);

  const projectValidation = validateProjectForm(editFormData);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saveLock.current) return;
    setShowFormErrors(true);
    const { errors, normalized } = validateProjectForm(editFormData);
    if (Object.keys(errors).length > 0) return;
    saveLock.current = true;
    setIsSaving(true);
    try {
      const updated = await updateProject(id, {
        name: normalized.name,
        location: normalized.location,
        budget_estimate: normalized.budget,
        status: normalized.status,
        start_date: normalized.start_date,
        target_completion_date: normalized.target_completion_date,
      });
      if (updated) {
        setIsEditModalOpen(false);
        setShowFormErrors(false);
        showToast('success', 'Project updated.');
      }
    } catch {
      showToast('error', 'Project update was not confirmed. Refresh and check the project before retrying.');
    } finally {
      saveLock.current = false;
      setIsSaving(false);
    }
  };

  const handleDelete = () => setIsDeleteDialogOpen(true);

  const confirmDelete = async () => {
    if (deleteLock.current) return;
    deleteLock.current = true;
    setIsDeleting(true);
    try {
      const success = await deleteProject(id);
      if (success) {
        setIsDeleteDialogOpen(false);
        router.push('/projects');
      } else {
        // A network failure may have committed. Do not keep an immediate retry
        // button open; check the current list before attempting another removal.
        setIsDeleteDialogOpen(false);
      }
    } catch {
      setIsDeleteDialogOpen(false);
      showToast('error', 'Project deletion was not confirmed. Refresh and check the project list before retrying.');
    } finally {
      deleteLock.current = false;
      setIsDeleting(false);
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Navigation & Header */}
        <div>
          <Link
            href="/projects"
            className="inline-flex items-center space-x-2 text-xs font-semibold text-ink-secondary hover:text-navy transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Projects</span>
          </Link>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-surface-border/60">
            <div>
              <div className="flex items-center space-x-2">
                <Badge variant={project.status === 'active' ? 'success' : 'navy'} size="sm" className="capitalize">
                  {project.status.replace(/_/g, ' ')}
                </Badge>
                {isFounder && <span className="text-xs text-ink-secondary">Client: {client?.name}</span>}
              </div>
              <h1 className="text-2xl sm:text-3xl font-semibold text-navy tracking-tight mt-1.5">
                {project.name}
              </h1>
              <div className="flex flex-wrap items-center gap-4 mt-2 text-xs text-ink-secondary">
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-navy" />
                  {project.location}
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-navy" />
                  {project.start_date} to {project.target_completion_date}
                </span>
              </div>
            </div>

            {isFounder && (
              <div className="flex items-center space-x-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setEditFormData({
                      name: project.name,
                      location: project.location,
                      budget_estimate: String(project.budget_estimate),
                      status: project.status,
                      start_date: project.start_date,
                      target_completion_date: project.target_completion_date,
                    });
                    setShowFormErrors(false);
                    setIsEditModalOpen(true);
                  }}
                  leftIcon={<Edit2 className="w-3.5 h-3.5" />}
                >
                  Edit Project
                </Button>
                <Button variant="outline" size="sm" onClick={handleDelete} aria-label={`Delete ${project.name}`} className="min-w-11 text-status-danger hover:bg-status-danger-bg">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>

        {isFounder && <ProjectPhotoManager projectId={project.id} />}

        {/* Tab Navigation */}
        <div className="grid grid-cols-2 gap-x-2 border-b border-surface-border/80 sm:flex sm:flex-wrap">
          {[
            { id: 'overview', label: 'Overview & Summary' },
            ...(isFounder ? [{ id: 'invoices', label: `Invoices (${projInvoices.length})` }] : []),
            ...(isFounder ? [{ id: 'expenses', label: `Expenses (${projExpenses.length})` }] : []),
            { id: 'tools', label: `Site Tools (${projTools.length})` },
            { id: 'workers', label: 'Project Workers' },
            { id: 'attendance', label: `Workforce Logs (${projAttendance.length} loaded)` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              aria-pressed={activeTab === tab.id}
              className={`min-h-11 px-3 sm:px-4 py-2 text-xs font-semibold text-center break-words transition-[color,border-color,transform] duration-200 motion-safe:active:scale-[0.96] sm:motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand border-b-2 ${
                tab.id === 'overview' ? 'col-span-2 sm:col-span-1' : ''
              } ${
                activeTab === tab.id
                  ? 'border-brand text-brand'
                  : 'border-transparent text-ink-secondary hover:text-navy'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* TAB 1: OVERVIEW */}
        {activeTab === 'overview' && (
          <div className="animate-panel-enter animate-panel-lift space-y-6">
            {/* Financial summary metrics (Founder only) */}
            {isFounder && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-xl bg-white border border-surface-border">
                  <div className="text-xs font-medium text-ink-secondary">Budget Estimate</div>
                  <div className="text-xl font-bold text-navy mt-1">{project.budget_estimate == null ? "Unavailable" : formatPHP(project.budget_estimate)}</div>
                  <div className="text-[11px] text-ink-muted mt-0.5">Saved estimate</div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-surface-border">
                  <div className="text-xs font-medium text-ink-secondary">Invoice totals</div>
                  <div className="text-xl font-bold text-navy mt-1">{formatPHP(totalInvoiced)}</div>
                  <div className="text-[11px] text-ink-secondary mt-0.5">{formatPHP(totalCollected)} collected · includes all invoice statuses</div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-surface-border">
                  <div className="text-xs font-medium text-ink-secondary">Site Expenses</div>
                  <div className="text-xl font-bold text-navy mt-1">{formatPHP(totalExpenses)}</div>
                  <div className="text-[11px] text-ink-secondary mt-0.5">{budget.percent === null ? 'No estimate set' : `${Math.round(budget.percent)}% of estimate`}</div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-surface-border">
                  <div className="text-xs font-medium text-ink-secondary">Collected less recorded expenses</div>
                  <div className={`text-xl font-bold mt-1 ${totalCollected - totalExpenses < 0 ? 'text-status-danger' : 'text-navy'}`}>
                    {formatPeso(totalCollected - totalExpenses)}
                  </div>
                  <div className="text-[11px] text-ink-secondary mt-0.5">Not profit; excludes unrecorded costs and other payments.</div>
                </div>
              </div>
            )}

            {/* Project Site Details */}
            <div className={`grid grid-cols-1 gap-6 ${isFounder ? 'lg:grid-cols-2' : ''}`}>
              {isFounder && <Card>
                <CardHeader>
                  <CardTitle>Site & Client Specifications</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-xs">
                  <div className="flex items-start justify-between gap-3 py-1.5 border-b border-surface-border/60">
                    <span className="text-ink-secondary">Client Name:</span>
                    <span className="min-w-0 max-w-[60%] break-words text-right font-bold text-navy">{client?.name}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 py-1.5 border-b border-surface-border/60">
                    <span className="text-ink-secondary">Contact Person:</span>
                    <span className="min-w-0 max-w-[60%] break-words text-right font-medium text-navy">{client?.contact_person}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 py-1.5 border-b border-surface-border/60">
                    <span className="text-ink-secondary">Phone Number:</span>
                    <span className="min-w-0 max-w-[60%] break-words text-right font-medium text-navy">{client?.phone}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 py-1.5 border-b border-surface-border/60">
                    <span className="text-ink-secondary">Client Email:</span>
                    <span className="min-w-0 max-w-[60%] break-words text-right font-medium text-navy">{client?.email}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 py-1.5">
                    <span className="text-ink-secondary">Site Address:</span>
                    <span className="min-w-0 max-w-[60%] break-words font-medium text-navy text-right">{project.location}</span>
                  </div>
                </CardContent>
              </Card>}

              {/* Assigned Supervisors */}
              <Card>
                <CardHeader>
                  <CardTitle>Assigned Site Supervisors</CardTitle>
                  <CardDescription>Authorized supervisors recording attendance for this project</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {assignedSupervisors.length > 0 ? (
                      assignedSupervisors.map((sup) => (
                        <div
                          key={sup.id}
                          className="p-3 rounded-xl bg-surface-inset border border-surface-border flex items-center justify-between"
                        >
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-full bg-navy text-white flex items-center justify-center font-bold text-xs">
                              {sup.name[0]}
                            </div>
                            <div>
                              <div className="font-bold text-xs text-navy">{sup.name}</div>
                              <div className="text-[11px] text-ink-secondary break-words">{sup.email}</div>
                            </div>
                          </div>
                          <Badge variant="warning" size="sm">
                            Supervisor
                          </Badge>
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-ink-secondary italic p-4 text-center">
                        {isFounder ? 'No supervisor specifically assigned yet. Founders manage attendance by default.' : 'No assigned supervisors are visible to your account.'}
                      </div>
                    )}

                    <div className="pt-3">
                      <Link href="/attendance">
                        <Button variant="secondary" size="sm" className="w-full">
                          Open Attendance Terminal
                        </Button>
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* TAB 2: INVOICES (Founder only) */}
        {activeTab === 'invoices' && isFounder && (
          <div className="animate-panel-enter animate-panel-lift space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-navy text-sm">Project Milestone Invoices</h3>
              <Link href="/invoices">
                <Button variant="primary" size="sm" leftIcon={<Plus className="w-3.5 h-3.5" />}>
                  Create Invoice
                </Button>
              </Link>
            </div>

            <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
              <div className="divide-y divide-surface-border/70">
                {projInvoices.length > 0 ? (
                  projInvoices.map((inv) => (
                    <div key={inv.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="font-bold text-sm text-navy font-mono">{inv.invoice_number}</div>
                        <div className="text-xs text-ink-secondary mt-0.5">{inv.notes}</div>
                        <div className="text-[11px] text-ink-muted mt-1">Due Date: {inv.due_date}</div>
                      </div>
                      <div className="flex items-center space-x-4 text-right">
                        <div>
                          <div className="text-sm font-bold text-navy">{formatPHP(inv.amount)}</div>
                          <div className="text-xs text-status-success font-medium">
                            Paid: {formatPHP(inv.amount_paid)}
                          </div>
                        </div>
                        <Badge
                          variant={
                            inv.status === 'paid'
                              ? 'success'
                              : inv.status === 'overdue'
                              ? 'danger'
                              : 'warning'
                          }
                          size="sm"
                        >
                          {inv.status}
                        </Badge>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-8 text-center text-xs text-ink-secondary">
                    No invoices generated yet for this project.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: EXPENSES (Founder only) */}
        {activeTab === 'expenses' && isFounder && (
          <div className="animate-panel-enter animate-panel-lift space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-navy text-sm">Site Disbursements & Cost Ledger</h3>
              <Link href="/expenses">
                <Button variant="primary" size="sm" leftIcon={<Sparkles className="w-3.5 h-3.5" />}>
                  Record Expense
                </Button>
              </Link>
            </div>

            <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
              <div className="divide-y divide-surface-border/70">
                {projExpenses.length > 0 ? (
                  projExpenses.map((exp) => (
                    <div key={exp.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="font-bold text-xs sm:text-sm text-navy">{exp.description}</div>
                        <div className="text-xs text-ink-secondary mt-0.5 capitalize">
                          Category: {exp.category} · Date: {exp.expense_date}
                        </div>
                        {exp.notes && <div className="text-[11px] text-ink-muted mt-0.5">{exp.notes}</div>}
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold text-navy">{formatPHP(exp.amount)}</div>
                        <Badge variant="navy" size="sm" className="mt-1">
                          Confirmed
                        </Badge>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-8 text-center text-xs text-ink-secondary">
                    No site expenses recorded yet for this project.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: TOOLS */}
        {activeTab === 'tools' && (
          <div className="animate-panel-enter animate-panel-lift space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-navy text-sm">Tools Allocated to This Site</h3>
              {isFounder && (
                <Link href="/tools">
                  <Button variant="secondary" size="sm">Manage Tools</Button>
                </Link>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projTools.length > 0 ? (
                projTools.map((tool) => (
                  <div key={tool.id} className="p-4 rounded-xl bg-white border border-surface-border space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="w-8 h-8 rounded-xl bg-surface-inset text-navy flex items-center justify-center">
                        <Wrench className="w-4 h-4" />
                      </div>
                      <Badge variant={tool.condition === 'excellent' ? 'success' : 'warning'} size="sm">
                        {tool.condition}
                      </Badge>
                    </div>
                    <div className="font-bold text-xs text-navy mt-2">{tool.name}</div>
                    <div className="text-xs text-ink-secondary">Quantity: {tool.quantity} unit(s)</div>
                  </div>
                ))
              ) : (
                <div className="col-span-full p-8 text-center bg-white rounded-2xl border border-surface-border text-xs text-ink-secondary">
                  No heavy machinery or special tools logged on this site.
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'workers' && <ProjectWorkers key={id} projectId={id} />}

        {/* TAB 5: ATTENDANCE */}
        {activeTab === 'attendance' && (
          <ProjectWorkforceLogs key={id} records={projAttendance} workers={workers} />
        )}
      </div>

      {/* Edit Modal (Founder only) */}
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        dismissOnBackdrop={!isSaving}
        dismissOnEscape={!isSaving}
        showCloseButton={!isSaving}
        title="Edit Project Details"
        description="Update project milestones and budget allocation."
      >
        <form onSubmit={handleUpdate} noValidate className="space-y-4 text-xs">
          {showFormErrors && Object.keys(projectValidation.errors).length > 0 && (
            <p role="alert" className="text-xs font-semibold text-status-danger">Please correct the highlighted project fields.</p>
          )}
          <fieldset disabled={isSaving} className="space-y-4">
            <Input
              label="Project Name"
              error={showFormErrors ? projectValidation.errors.name : undefined}
              value={editFormData.name}
              onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
              required
            />

            <Input
              label="Location"
              error={showFormErrors ? projectValidation.errors.location : undefined}
              value={editFormData.location}
              onChange={(e) => setEditFormData({ ...editFormData, location: e.target.value })}
              required
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Budget Estimate"
                error={showFormErrors ? projectValidation.errors.budget_estimate : undefined}
                type="number"
                min="0"
                step="0.01"
                value={editFormData.budget_estimate}
                onChange={(e) => setEditFormData({ ...editFormData, budget_estimate: e.target.value })}
                required
              />

              <Select
                label="Status"
                value={editFormData.status}
                onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value as ProjectStatus })}
              >
                <option value="planning">Planning</option>
                <option value="active">Active</option>
                <option value="on_hold">On Hold</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Start Date"
                error={showFormErrors ? projectValidation.errors.start_date : undefined}
                type="date"
                value={editFormData.start_date}
                onChange={(e) => setEditFormData({ ...editFormData, start_date: e.target.value })}
              />
              <Input
                label="Target Completion Date"
                error={showFormErrors ? projectValidation.errors.target_completion_date : undefined}
                type="date"
                value={editFormData.target_completion_date}
                onChange={(e) => setEditFormData({ ...editFormData, target_completion_date: e.target.value })}
              />
            </div>

            <div className="pt-3 flex justify-end space-x-2">
              <Button type="button" variant="secondary" onClick={() => setIsEditModalOpen(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" isLoading={isSaving}>
                {isSaving ? 'Saving changes…' : 'Save Changes'}
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={isDeleteDialogOpen}
        title="Delete project"
        message={`Delete ${project.name}? This cannot be undone.`}
        destructive
        isPending={isDeleting}
        confirmLabel={isDeleting ? "Deleting…" : "Delete project"}
        onConfirm={confirmDelete}
        onCancel={() => setIsDeleteDialogOpen(false)}
      />
    </AppShell>
  );
}
