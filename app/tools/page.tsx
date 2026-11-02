'use client';

import React, { useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Tool, ToolCondition } from '@/types';
import {
  Wrench,
  Plus,
  Search,
  Edit2,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { useToast } from '@/components/ui/Toast';
import { parseToolQuantity } from '@/lib/tools/validation';

export default function ToolsPage() {
  const { tools, projects, createTool, updateTool, deleteTool, refresh } = useDataStore();
  const { showToast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const saveLock = useRef(false);
  const deleteLock = useRef(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [conditionFilter, setConditionFilter] = useState<string>('all');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    quantity: '1',
    condition: 'excellent' as ToolCondition,
    project_id: '',
  });

  const filteredTools = tools.filter((t) => {
    const proj = projects.find((p) => p.id === t.project_id);
    const matchesSearch =
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      proj?.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCondition = conditionFilter === 'all' || t.condition === conditionFilter;
    return matchesSearch && matchesCondition;
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saveLock.current || (isEditModalOpen && !selectedTool)) return;
    const quantity = parseToolQuantity(formData.quantity);
    if (!formData.name.trim() || quantity === null) {
      showToast('error', 'Enter a tool name and a whole-number quantity of zero or more.');
      return;
    }
    saveLock.current = true;
    setIsSaving(true);
    try {
      const payload = { name: formData.name.trim(), quantity, condition: formData.condition, project_id: formData.project_id || null };
      const saved = isEditModalOpen && selectedTool
        ? await updateTool(selectedTool.id, payload)
        : await createTool(payload);
      if (saved) {
        showToast('success', isEditModalOpen ? 'Equipment record updated.' : 'Equipment added to inventory.');
        setIsAddModalOpen(false);
        setIsEditModalOpen(false);
        setFormData({ name: '', quantity: '1', condition: 'excellent', project_id: '' });
      } else {
        showToast('error', 'Save not confirmed. Refresh and check inventory before retrying.');
      }
    } catch {
      showToast('error', 'Save not confirmed. Refresh and check inventory before retrying.');
    } finally {
      saveLock.current = false;
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleteLock.current) return;
    deleteLock.current = true;
    setIsDeleting(true);
    try {
      const deleted = await deleteTool(pendingDelete.id);
      if (deleted) {
        showToast('success', 'Equipment removed.');
        setPendingDelete(null);
      } else {
        showToast('error', 'Removal not confirmed. Refresh and check inventory before retrying.');
        await refresh();
      }
    } catch {
      showToast('error', 'Removal not confirmed. Refresh and check inventory before retrying.');
    } finally {
      deleteLock.current = false;
      setIsDeleting(false);
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Equipment"
          title="Tools & Equipment"
          description={`${tools.length} equipment record(s). Track condition and where each item is assigned.`}
          action={<Button variant="primary" size="sm" onClick={() => {
            setFormData({ name: '', quantity: '1', condition: 'excellent', project_id: '' });
            setIsAddModalOpen(true);
          }} leftIcon={<Plus className="w-4 h-4" />}>Add Tool</Button>}
        />
        <WorkspaceFilters title="Find equipment" summary={<FilterSummary count={filteredTools.length} itemName="tool" active={Boolean(searchQuery) || conditionFilter !== 'all'} onClear={() => { setSearchQuery(''); setConditionFilter('all'); }} />}>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="w-full sm:w-80">
              <Input label="Search tools" placeholder="Search tool or project name" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
            </div>
            <div className="w-full sm:w-48">
              <Select label="Condition" value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)} options={[
                { label: 'All Conditions', value: 'all' }, { label: 'Excellent', value: 'excellent' },
                { label: 'Good', value: 'good' }, { label: 'Fair', value: 'fair' },
                { label: 'Needs Repair', value: 'needs_repair' }, { label: 'Damaged', value: 'damaged' },
              ]} />
            </div>
          </div>
        </WorkspaceFilters>

        {/* Tools Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
          {filteredTools.map((tool) => {
            const proj = projects.find((p) => p.id === tool.project_id);

            const conditionBadgeVariant =
              tool.condition === 'excellent'
                ? 'success'
                : tool.condition === 'good'
                ? 'info'
                : tool.condition === 'fair'
                ? 'neutral'
                : 'danger';

            return (
              <div
                key={tool.id}
                className="h-full min-w-0 p-4 sm:p-5 rounded-xl bg-white border border-surface-border hover:border-brand/35 transition-colors duration-150 flex flex-col justify-between"
              >
                <div className="space-y-3 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="w-10 h-10 rounded-2xl bg-surface-inset text-navy flex items-center justify-center border border-surface-border shrink-0">
                      <Wrench className="w-5 h-5 text-navy" />
                    </div>

                    <div className="flex items-center space-x-1">
                      <button
                        type="button"
                        aria-label={`Edit ${tool.name}`}
                        title="Edit tool"
                        onClick={() => {
                          setSelectedTool(tool);
                          setFormData({
                            name: tool.name,
                            quantity: String(tool.quantity),
                            condition: tool.condition,
                            project_id: tool.project_id || '',
                          });
                          setIsEditModalOpen(true);
                        }}
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 inline-flex items-center justify-center rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${tool.name}`}
                        title="Delete tool"
                        onClick={() => setPendingDelete({ id: tool.id, name: tool.name })}
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 inline-flex items-center justify-center rounded-lg text-status-danger hover:bg-status-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-danger/25"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-bold text-sm text-navy">{tool.name}</h3>
                    <div className="text-xs text-ink-secondary mt-1">
                      Quantity: <span className="font-semibold text-navy">{tool.quantity} unit(s)</span>
                    </div>
                  </div>

                  {/* Allocation */}
                  <div className="p-3 rounded-xl bg-surface-inset/60 border border-surface-border text-xs">
                    <div className="text-[11px] font-medium text-ink-secondary">
                      Current Site Deployment
                    </div>
                    <div className="font-semibold text-navy mt-0.5">
                      {proj ? proj.name : tool.project_id ? 'Assigned project unavailable' : 'Asinta Studio Central Depot'}
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-surface-border/60 flex items-center justify-between">
                  <span className="text-xs text-ink-secondary">Condition Status</span>
                  <Badge variant={conditionBadgeVariant} size="sm" className="capitalize">
                    {tool.condition.replace('_', ' ')}
                  </Badge>
                </div>
              </div>
            );
          })}

          {filteredTools.length === 0 && (
            <div className="md:col-span-2 lg:col-span-3 bg-white rounded-xl border border-surface-border">
              <EmptyState
                title="No equipment to show"
                description={
                  tools.length === 0
                    ? 'Register site tools and machinery to track their location and condition.'
                    : 'No equipment matches the current search or filters.'
                }
                action={
                  tools.length === 0 ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => { setFormData({ name: '', quantity: '1', condition: 'excellent', project_id: '' }); setIsAddModalOpen(true); }}
                      leftIcon={<Plus className="w-3.5 h-3.5" />}
                    >
                      Register Tool
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* ADD / EDIT TOOL MODAL */}
      <Modal
        isOpen={isAddModalOpen || isEditModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setIsEditModalOpen(false);
        }}
        dismissOnBackdrop={!isSaving}
        dismissOnEscape={!isSaving}
        showCloseButton={!isSaving}
        title={isEditModalOpen ? 'Update Equipment Record' : 'Register New Tool / Machine'}
        description="Track site equipment location and maintenance state."
      >
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <Input
            label="Tool / Equipment Description"
            placeholder="e.g. Bosch Rotary Hammer Drill SDS-Plus"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Quantity (Units)"
              type="number"
              min="0"
              step="1"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
              required
            />

            <Select
              label="Equipment Condition"
              value={formData.condition}
              onChange={(e) => setFormData({ ...formData, condition: e.target.value as ToolCondition })}
            >
              <option value="excellent">Excellent / New</option>
              <option value="good">Good Working Condition</option>
              <option value="fair">Fair (Normal Wear)</option>
              <option value="needs_repair">Needs Maintenance / Repair</option>
              <option value="damaged">Damaged</option>
            </Select>
          </div>

          <Select
            label="Assigned Project Site"
            value={formData.project_id}
            onChange={(e) => setFormData({ ...formData, project_id: e.target.value })}
          >
            <option value="">Asinta Studio Central Depot (Batangas)</option>
            {formData.project_id && !projects.some((project) => project.id === formData.project_id) && (
              <option value={formData.project_id}>Assigned project unavailable</option>
            )}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>

          <div className="pt-3 flex justify-end space-x-2">
            <Button
              type="button"
              variant="secondary"
              disabled={isSaving}
              onClick={() => {
                setIsAddModalOpen(false);
                setIsEditModalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" isLoading={isSaving}>
              {isSaving ? 'Saving…' : isEditModalOpen ? 'Save Tool' : 'Add to Inventory'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        title="Remove equipment"
        description={pendingDelete ? `Remove ${pendingDelete.name}? This cannot be undone.` : ''}
        role="alertdialog"
        maxWidth="sm"
        dismissOnBackdrop={false}
        dismissOnEscape={!isDeleting}
        showCloseButton={!isDeleting}
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={isDeleting} onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button type="button" variant="danger" isLoading={isDeleting} onClick={confirmDelete}>{isDeleting ? 'Removing…' : 'Remove tool'}</Button>
        </div>
      </Modal>
    </AppShell>
  );
}
