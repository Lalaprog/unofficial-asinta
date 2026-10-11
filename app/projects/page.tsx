'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { ProjectStatus } from '@/types';
import {
  FolderKanban,
  Plus,
  Search,
  Calendar,
  MapPin,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { formatPesoCompact } from '@/lib/email/format';

export default function ProjectsPage() {
  const { isFounder, isSupervisor, user } = useAuth();
  const {
    projects,
    clients,
    invoices,
    expenses,
    createProject,
    getProjectsForSupervisor,
  } = useDataStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    client_id: '',
    location: '',
    budget_estimate: '',
    status: 'active' as ProjectStatus,
    start_date: new Date().toISOString().split('T')[0],
    target_completion_date: '2026-12-31',
  });

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
    if (!formData.name || !formData.client_id || !formData.budget_estimate) return;

    const created = await createProject({
      name: formData.name,
      client_id: formData.client_id,
      location: formData.location || 'Batangas',
      budget_estimate: parseFloat(formData.budget_estimate),
      status: formData.status,
      start_date: formData.start_date,
      target_completion_date: formData.target_completion_date,
    });

    if (created) {
      setIsCreateModalOpen(false);
      setFormData({
        name: '',
        client_id: '',
        location: '',
        budget_estimate: '',
        status: 'active',
        start_date: new Date().toISOString().split('T')[0],
        target_completion_date: '2026-12-31',
      });
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                {isFounder ? 'Architecture & Construction' : 'Field Assignments'}
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">
                {filteredProjects.length} Project Sites
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              {isFounder ? 'Projects & Sites Ledger' : 'My Assigned Project Sites'}
            </h1>
          </div>

          {isFounder && (
            <Button
              variant="primary"
              size="md"
              onClick={() => setIsCreateModalOpen(true)}
              leftIcon={<Plus className="w-4 h-4" />}
            >
              New Project
            </Button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <div className="w-full sm:w-72">
            <Input
              placeholder="Search projects or locations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />
          </div>

          <div className="w-full sm:w-48">
            <Select
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

        {/* Projects Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6 auto-rows-fr">
          {filteredProjects.map((proj) => {
            const client = clients.find((c) => c.id === proj.client_id);
            const projInvoices = invoices.filter((i) => i.project_id === proj.id);
            const projExpenses = expenses.filter((e) => e.project_id === proj.id);

            const totalInvoiced = projInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
            const totalCollected = projInvoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);
            const totalExp = projExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
            const remainingBudget = Math.max(0, proj.budget_estimate - totalExp);

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
                className="h-full min-w-0 bg-white rounded-3xl p-6 border border-surface-border/80 shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)] hover:shadow-[10px_10px_26px_rgba(11,31,58,0.09),-10px_-10px_26px_rgba(255,255,255,1)] hover:border-navy/30 transition-all flex flex-col justify-between group"
              >
                <div className="min-w-0">
                  {/* Top line */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="text-xs font-semibold text-ink-secondary uppercase tracking-wider truncate">
                        {client?.name || 'Private Client'}
                      </div>
                      <h3
                        className="text-lg font-bold text-navy group-hover:text-navy-light transition-colors truncate"
                        title={proj.name}
                      >
                        {proj.name}
                      </h3>
                    </div>
                    <Badge variant={statusBadgeVariant} size="sm" className="shrink-0">
                      {proj.status.replace('_', ' ')}
                    </Badge>
                  </div>

                  {/* Location & Timeline */}
                  <div className="mt-4 space-y-2 text-xs text-ink-secondary">
                    <div className="flex items-center space-x-2 min-w-0">
                      <MapPin className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span className="truncate">{proj.location}</span>
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
                        <span className="font-bold text-navy">{formatPHP(proj.budget_estimate)}</span>
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

                      {/* Progress bar */}
                      <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden mt-2">
                        <div
                          className="h-full bg-navy"
                          style={{
                            width: `${Math.min(100, (totalExp / (proj.budget_estimate || 1)) * 100)}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-ink-secondary">
                        <span>Cost Consumed: {Math.round((totalExp / (proj.budget_estimate || 1)) * 100)}%</span>
                        <span>Remaining: {formatPHP(remainingBudget)}</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer action */}
                <div className="mt-6 pt-4 border-t border-surface-border/60 flex items-center justify-between">
                  <Link href={`/projects/${proj.id}`} className="w-full">
                    <Button variant="secondary" size="sm" className="w-full justify-between">
                      <span>{isFounder ? 'View Project Ledger & Site Details' : 'View Site Roster & Details'}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        {filteredProjects.length === 0 && (
          <div className="p-12 text-center bg-white rounded-3xl border border-surface-border text-ink-secondary">
            <FolderKanban className="w-10 h-10 mx-auto text-ink-muted mb-2" />
            <div className="font-bold text-navy text-sm">No Projects Found</div>
            <div className="text-xs text-ink-secondary mt-1">
              Try adjusting your filter or search query.
            </div>
          </div>
        )}
      </div>

      {/* Create Project Modal (Founder only) */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Create New Project"
        description="Initialize an architectural or design-build project in Batangas."
        maxWidth="lg"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4 text-xs">
          <Input
            label="Project Name"
            placeholder="e.g. Batangas Modern Villa & Pavilion"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />

          <Select
            label="Client"
            value={formData.client_id}
            onChange={(e) => setFormData({ ...formData, client_id: e.target.value })}
            required
          >
            <option value="">Select an existing client...</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.contact_person})
              </option>
            ))}
          </Select>

          <Input
            label="Site Location"
            placeholder="e.g. Ayala Greenfield Estates, Calamba / Sto. Tomas"
            value={formData.location}
            onChange={(e) => setFormData({ ...formData, location: e.target.value })}
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Budget Estimate (PHP ₱)"
              type="number"
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
              type="date"
              value={formData.start_date}
              onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
              required
            />

            <Input
              label="Target Completion Date"
              type="date"
              value={formData.target_completion_date}
              onChange={(e) => setFormData({ ...formData, target_completion_date: e.target.value })}
              required
            />
          </div>

          <div className="pt-4 flex justify-end space-x-2">
            <Button variant="secondary" onClick={() => setIsCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              Create Project
            </Button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}
