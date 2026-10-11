'use client';

import React, { useState } from 'react';
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
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export default function ToolsPage() {
  const { tools, projects, createTool, updateTool, deleteTool } = useDataStore();

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

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return;

    const created = await createTool({
      name: formData.name,
      quantity: parseInt(formData.quantity) || 1,
      condition: formData.condition,
      project_id: formData.project_id || null,
    });

    if (created) {
      setIsAddModalOpen(false);
      setFormData({ name: '', quantity: '1', condition: 'excellent', project_id: '' });
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTool) return;

    const updated = await updateTool(selectedTool.id, {
      name: formData.name,
      quantity: parseInt(formData.quantity) || 1,
      condition: formData.condition,
      project_id: formData.project_id || null,
    });

    if (updated) {
      setIsEditModalOpen(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    setPendingDelete({ id, name });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await deleteTool(target.id);
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-surface-border/60">
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-navy tracking-tight">
              Tools &amp; Equipment
            </h1>
            <p className="text-xs text-ink-secondary mt-0.5">
              {tools.length} logged site tools and plant items
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setFormData({ name: '', quantity: '1', condition: 'excellent', project_id: '' });
              setIsAddModalOpen(true);
            }}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            Add Tool
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <div className="w-full sm:w-80">
            <Input
              placeholder="Search tool name, brand, model..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />
          </div>

          <div className="w-full sm:w-48">
            <Select
              value={conditionFilter}
              onChange={(e) => setConditionFilter(e.target.value)}
              options={[
                { label: 'All Conditions', value: 'all' },
                { label: 'Excellent', value: 'excellent' },
                { label: 'Good', value: 'good' },
                { label: 'Fair', value: 'fair' },
                { label: 'Needs Repair', value: 'needs_repair' },
                { label: 'Damaged', value: 'damaged' },
              ]}
            />
          </div>
        </div>

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
                className="h-full min-w-0 p-5 rounded-3xl bg-white border border-surface-border shadow-[5px_5px_15px_rgba(11,31,58,0.05),-5px_-5px_15px_rgba(255,255,255,0.95)] hover:border-navy/30 transition-all flex flex-col justify-between"
              >
                <div className="space-y-3 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="w-10 h-10 rounded-2xl bg-surface-inset text-navy flex items-center justify-center border border-surface-border shadow-[inset_1px_1px_3px_rgba(11,31,58,0.06)] shrink-0">
                      <Wrench className="w-5 h-5 text-navy" />
                    </div>

                    <div className="flex items-center space-x-1">
                      <button
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
                        className="p-1.5 rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(tool.id, tool.name)}
                        className="p-1.5 rounded-lg text-status-danger hover:bg-status-danger-bg"
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
                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-secondary">
                      Current Site Deployment
                    </div>
                    <div className="font-semibold text-navy mt-0.5">
                      {proj ? proj.name : 'Asinta Studio Central Depot'}
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
            <div className="md:col-span-2 lg:col-span-3 bg-white rounded-3xl border border-surface-border">
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
                      onClick={() => setIsAddModalOpen(true)}
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
        title={isEditModalOpen ? 'Update Equipment Record' : 'Register New Tool / Machine'}
        description="Track site equipment location and maintenance state."
      >
        <form onSubmit={isEditModalOpen ? handleEditSubmit : handleAddSubmit} className="space-y-4 text-xs">
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
              min="1"
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
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>

          <div className="pt-3 flex justify-end space-x-2">
            <Button
              variant="secondary"
              onClick={() => {
                setIsAddModalOpen(false);
                setIsEditModalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              {isEditModalOpen ? 'Save Tool' : 'Add to Inventory'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(pendingDelete)}
        title="Remove equipment"
        message={pendingDelete ? `Remove ${pendingDelete.name}? This cannot be undone.` : ''}
        confirmLabel="Remove tool"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </AppShell>
  );
}
