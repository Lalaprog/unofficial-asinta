'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { ProjectStatus } from '@/types';
import {
  Plus,
  Search,
  Calendar,
  MapPin,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { formatPesoCompact } from '@/lib/email/format';
import { getBudgetSummary } from '@/lib/projects/budgetSummary';
import { ProjectCover } from '@/components/projects/ProjectCover';
import { localDateInputValue, validateProjectForm } from '@/lib/projects/form';
import { normalizeClientForm } from '@/lib/clients/form';

export default function ProjectsPage() {
  const { isFounder, isSupervisor, user } = useAuth();
  const { showToast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const creatingRef = React.useRef(false);
  const {
    projects,
    clients,
    invoices,
    expenses,
    createProject,
    createClient,
    getProjectsForSupervisor,
  } = useDataStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [showFormErrors, setShowFormErrors] = useState(false);
  const [isClientModalOpen, setIsClientModalOpen] = useState(false);
  const [isSavingClient, setIsSavingClient] = useState(false);
  const [clientSaveUnconfirmed, setClientSaveUnconfirmed] = useState(false);
  const clientSaveLock = React.useRef(false);
  const [clientForm, setClientForm] = useState({ name: '', contact_person: '', phone: '', email: '', address: '' });

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    client_id: '',
    location: '',
    budget_estimate: '',
    status: 'active' as ProjectStatus,
    start_date: localDateInputValue(),
    target_completion_date: '',
  });

  const projectValidation = validateProjectForm(formData, formData.client_id);

  // Filter projects by role
  const accessibleProjects = isSupervisor && user
    ? getProjectsForSupervisor(user.id)
    : projects;

  const filteredProjects = accessibleProjects.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.location.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const formatPHP = formatPesoCompact;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRef.current) return;
    setShowFormErrors(true);
    const { errors, normalized } = validateProjectForm(formData, formData.client_id);
    if (Object.keys(errors).length > 0) return;
    creatingRef.current = true;
    setIsCreating(true);
    try {
      const created = await createProject({
        name: normalized.name,
        client_id: formData.client_id,
        location: normalized.location,
        budget_estimate: normalized.budget,
        status: formData.status,
        start_date: formData.start_date,
        target_completion_date: formData.target_completion_date,
      });

      if (created) {
        showToast('success', 'Project created.');
        setIsCreateModalOpen(false);
        setShowFormErrors(false);
        setFormData({
          name: '',
          client_id: '',
          location: '',
          budget_estimate: '',
          status: 'active',
          start_date: localDateInputValue(),
          target_completion_date: '',
        });
      }
    } catch {
      showToast('error', 'Could not confirm whether the project was created. Refresh and check the project list before trying again.');
    } finally {
      creatingRef.current = false;
      setIsCreating(false);
    }
  };

  const handleCreateClient = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isFounder || clientSaveLock.current || clientSaveUnconfirmed) return;
    const payload = normalizeClientForm(clientForm);
    if (!payload) {
      showToast('error', 'Complete every field with the client’s actual contact details.');
      return;
    }
    clientSaveLock.current = true;
    setIsSavingClient(true);
    try {
      const client = await createClient(payload);
      if (!client) {
        setClientSaveUnconfirmed(true);
        return;
      }
      setFormData((current) => ({ ...current, client_id: client.id }));
      setIsClientModalOpen(false);
      setClientForm({ name: '', contact_person: '', phone: '', email: '', address: '' });
      showToast('success', 'Client added and selected. The project has not been created yet.');
    } catch {
      setClientSaveUnconfirmed(true);
    } finally {
      clientSaveLock.current = false;
      setIsSavingClient(false);
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Projects & sites"
          title={isFounder ? 'Project Sites' : 'Assigned Projects'}
          description={isFounder ? 'Review your sites, estimates, recorded costs and client billing.' : 'Find your assigned sites and open their details.'}
          action={isFounder ? (
            <Button variant="primary" size="md" onClick={() => setIsCreateModalOpen(true)} leftIcon={<Plus className="w-4 h-4" />}>
              New Project
            </Button>
          ) : undefined}
        />

        <WorkspaceFilters
          title="Find a project"
          summary={<FilterSummary count={filteredProjects.length} itemName="project" active={Boolean(searchQuery) || statusFilter !== 'all'} onClear={() => { setSearchQuery(''); setStatusFilter('all'); }} />}
        >
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="w-full sm:w-72">
              <Input
                label="Search projects"
                placeholder="Search projects or locations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
              />
            </div>

            <div className="w-full sm:w-48">
              <Select
                label="Status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                options={[
                  { label: 'All Statuses', value: 'all' },
                  { label: 'Active', value: 'active' },
                  { label: 'Planning', value: 'planning' },
                  { label: 'On Hold', value: 'on_hold' },
                  { label: 'Completed', value: 'completed' },
                ]}
              />
            </div>
          </div>
        </WorkspaceFilters>

        {/* Projects Cards Grid */}
        <div data-page-guide="list" className="grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-fr">
          {filteredProjects.map((proj) => {
            const client = clients.find((c) => c.id === proj.client_id);
            const projInvoices = invoices.filter((i) => i.project_id === proj.id);
            const projExpenses = expenses.filter((e) => e.project_id === proj.id);

            const totalInvoiced = projInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
            const totalCollected = projInvoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);
            const totalExp = projExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
            const budget = getBudgetSummary(Number(proj.budget_estimate), totalExp);

            const statusBadgeVariant =
              proj.status === 'active'
                ? 'success'
                : proj.status === 'planning'
                ? 'info'
                : proj.status === 'completed'
                ? 'navy'
                : 'warning';

            return (
              <div
                key={proj.id}
                className="h-full min-w-0 bg-white rounded-xl p-4 sm:p-5 border border-surface-border/80 hover:border-brand/35 transition-colors duration-150 flex flex-col justify-between group"
              >
                <div className="min-w-0">
                  {/* Top line */}
                  <ProjectCover projectId={proj.id}>
                    <div className="space-y-1 min-w-0 flex-1">
                      {isFounder && (
                        <div className="text-xs font-medium text-white/80 break-words">
                          {client?.name || 'Private Client'}
                        </div>
                      )}
                      <h3
                        className="text-lg font-bold text-white transition-colors break-words"
                        title={proj.name}
                      >
                        {proj.name}
                      </h3>
                    </div>
                    <Badge variant={statusBadgeVariant} size="sm" className="shrink-0">
                      {proj.status.replace('_', ' ')}
                    </Badge>
                  </ProjectCover>

                  {/* Location & Timeline */}
                  <div className="mt-4 space-y-2 text-xs text-ink-secondary">
                    <div className="flex items-center space-x-2 min-w-0">
                      <MapPin className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span className="break-words">{proj.location}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Calendar className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span className="tabular-nums">
                        {proj.start_date} → {proj.target_completion_date}
                      </span>
                    </div>
                  </div>

                  {/* Financial Overview (Founder only) */}
                  {isFounder && (
                    <div className="mt-5 p-3.5 rounded-2xl bg-surface-inset/50 border border-surface-border/70 space-y-2.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-ink-secondary">Budget Estimate:</span>
                        <span className="font-bold text-navy">{proj.budget_estimate == null ? "Unavailable" : formatPHP(proj.budget_estimate)}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-ink-secondary">Collected / Invoiced:</span>
                        <span className="font-semibold text-status-success">
                          {formatPHP(totalCollected)} <span className="text-ink-muted">/ {formatPHP(totalInvoiced)}</span>
                        </span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-ink-secondary">Total Site Expenses:</span>
                        <span className="font-semibold text-navy">{formatPHP(totalExp)}</span>
                      </div>

                      <p className="text-[11px] leading-relaxed text-ink-secondary">Invoice totals include all recorded statuses, including drafts and cancelled invoices.</p>
                      {budget.percent === null ? (
                        <p className="text-xs font-semibold text-ink-secondary">Budget usage unavailable — no estimate set.</p>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap justify-between gap-1 text-xs text-ink-secondary">
                            <span>Recorded costs: {Math.round(budget.percent)}% of estimate</span>
                            <span className={budget.over ? 'font-semibold text-status-danger' : ''}>
                              {budget.over ? `${formatPHP(budget.over)} over estimate` : `${formatPHP(budget.remaining ?? 0)} remaining`}
                            </span>
                          </div>
                          <div
                            role="progressbar"
                            aria-label={`Recorded costs for ${proj.name} as a percentage of its estimate`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(budget.barPercent)}
                            aria-valuetext={`${Math.round(budget.percent)}% of estimate used`}
                            className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
                          >
                            <div className={`h-full ${budget.over ? 'bg-status-danger' : 'bg-brand'}`} style={{ width: `${budget.barPercent}%` }} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer action */}
                <div className="mt-6 pt-4 border-t border-surface-border/60 flex items-center justify-between">
                  <Link href={`/projects/${proj.id}`} prefetch={false} className="inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-surface-border bg-white px-3 text-xs font-semibold text-navy transition-colors hover:border-brand/40 hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                    <span>{isFounder ? 'View Project Ledger & Site Details' : 'View Site Roster & Details'}</span>
                    <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        {filteredProjects.length === 0 && (
          <div className="rounded-xl border border-surface-border bg-white">
            <EmptyState title={accessibleProjects.length === 0 ? 'No projects yet' : 'No projects match'}
              description={accessibleProjects.length === 0 ? 'There are no projects available to you yet.' : 'Try clearing the search or filters.'}
              action={accessibleProjects.length === 0 && isFounder ? <Button variant="primary" size="sm" onClick={() => setIsCreateModalOpen(true)}>Create your first project</Button> : accessibleProjects.length > 0 ? <Button variant="secondary" size="sm" onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}>Clear filters</Button> : undefined} />
          </div>
        )}
      </div>

      {/* Create Project Modal (Founder only) */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        dismissOnBackdrop={!isCreating}
        dismissOnEscape={!isCreating}
        showCloseButton={!isCreating}
        title="Create New Project"
        description="Initialize an architectural or design-build project in Batangas."
        maxWidth="lg"
      >
        <form onSubmit={handleCreateSubmit} noValidate className="space-y-4 text-xs">
          {showFormErrors && Object.keys(projectValidation.errors).length > 0 && (
            <p role="alert" className="text-xs font-semibold text-status-danger">Please correct the highlighted project fields.</p>
          )}
          <fieldset disabled={isCreating} className="space-y-4">
            <Input
              label="Project Name"
              error={showFormErrors ? projectValidation.errors.name : undefined}
              placeholder="e.g. Batangas Modern Villa & Pavilion"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />

            <SearchableSelect
              label="Client"
              searchLabel="Search clients"
              error={showFormErrors ? projectValidation.errors.client_id : undefined}
              value={formData.client_id}
              onChange={(e) => setFormData({ ...formData, client_id: e.target.value })}
              fixedOption={{ value: '', label: 'Select an existing client...' }}
              options={clients.map((client) => ({ value: client.id, label: `${client.name} (${client.contact_person})` }))}
              required
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => { setClientForm({ name: '', contact_person: '', phone: '', email: '', address: '' }); setClientSaveUnconfirmed(false); setIsClientModalOpen(true); }}>
                Add New Client
              </Button>
              <span className="text-ink-secondary">Check the list first to avoid duplicates. New clients are saved separately.</span>
            </div>

            <Input
              label="Site Location"
              error={showFormErrors ? projectValidation.errors.location : undefined}
              placeholder="e.g. Ayala Greenfield Estates, Calamba / Sto. Tomas"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              required
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Budget Estimate (PHP ₱)"
                error={showFormErrors ? projectValidation.errors.budget_estimate : undefined}
                type="number"
                min="0"
                step="0.01"
                placeholder="8500000"
                value={formData.budget_estimate}
                onChange={(e) => setFormData({ ...formData, budget_estimate: e.target.value })}
                required
              />

              <Select
                label="Initial Status"
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value as ProjectStatus })}
              >
                <option value="planning">Planning & Design</option>
                <option value="active">Active Construction</option>
                <option value="on_hold">On Hold</option>
              </Select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Start Date"
                error={showFormErrors ? projectValidation.errors.start_date : undefined}
                type="date"
                value={formData.start_date}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                required
              />

              <Input
                label="Target Completion Date"
                error={showFormErrors ? projectValidation.errors.target_completion_date : undefined}
                type="date"
                value={formData.target_completion_date}
                onChange={(e) => setFormData({ ...formData, target_completion_date: e.target.value })}
                required
              />
            </div>

            <div className="pt-4 flex justify-end space-x-2">
              <Button type="button" variant="secondary" onClick={() => setIsCreateModalOpen(false)} disabled={isCreating}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" isLoading={isCreating}>
                {isCreating ? 'Creating project…' : 'Create Project'}
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>

      {/* A separate, stacked dialog preserves the project draft while adding a client. */}
      <Modal
        isOpen={isFounder && isCreateModalOpen && isClientModalOpen}
        onClose={() => setIsClientModalOpen(false)}
        dismissOnBackdrop={!isSavingClient}
        dismissOnEscape={!isSavingClient}
        showCloseButton={!isSavingClient}
        title="Add New Client"
        description="The client is saved to the directory immediately, even if you later cancel the project."
      >
        <form onSubmit={handleCreateClient} className="space-y-4 text-xs">
          {clientSaveUnconfirmed && <p role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning-bg p-3 text-navy">
            Client save was not confirmed. Close this form, refresh and check the client directory before trying again to avoid a duplicate. Your project details are still here.
          </p>}
          <fieldset disabled={isSavingClient || clientSaveUnconfirmed} className="space-y-4">
            <Input label="Client / Company Name" value={clientForm.name}
              onChange={(event) => setClientForm((current) => ({ ...current, name: event.target.value }))} required />
            <Input label="Contact Person / Representative" value={clientForm.contact_person}
              onChange={(event) => setClientForm((current) => ({ ...current, contact_person: event.target.value }))} required />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input label="Contact Number" type="tel" autoComplete="tel" value={clientForm.phone}
                onChange={(event) => setClientForm((current) => ({ ...current, phone: event.target.value }))} required />
              <Input label="Email Address" type="email" autoComplete="email" value={clientForm.email}
                onChange={(event) => setClientForm((current) => ({ ...current, email: event.target.value }))} required />
            </div>
            <Input label="Billing / Residence Address" value={clientForm.address}
              onChange={(event) => setClientForm((current) => ({ ...current, address: event.target.value }))} required />
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2 pt-3">
            <Button type="button" variant="secondary" disabled={isSavingClient} onClick={() => setIsClientModalOpen(false)}>
              {clientSaveUnconfirmed ? 'Back to Project' : 'Cancel'}
            </Button>
            <Button type="submit" isLoading={isSavingClient} disabled={clientSaveUnconfirmed}>
              {isSavingClient ? 'Saving client…' : 'Save and Select Client'}
            </Button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}
