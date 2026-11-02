'use client';

import React, { useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Client } from '@/types';
import {
  Plus,
  Search,
  Phone,
  Mail,
  MapPin,
  Edit2,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { useToast } from '@/components/ui/Toast';
import { formatPeso } from '@/lib/email/format';
import { normalizeClientForm } from '@/lib/clients/form';

export default function ClientsPage() {
  const { clients, projects, invoices, createClient, updateClient, deleteClient, refresh } = useDataStore();
  const { showToast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const saveLock = useRef(false);
  const deleteLock = useRef(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    contact_person: '',
    phone: '',
    email: '',
    address: '',
  });

  const filteredClients = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.contact_person.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.address.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saveLock.current || (isEditModalOpen && !selectedClient)) return;
    const payload = normalizeClientForm(formData);
    if (!payload) {
      showToast('error', 'Complete every field with the client’s actual contact details.');
      return;
    }
    saveLock.current = true;
    setIsSaving(true);
    try {
      const saved = isEditModalOpen && selectedClient
        ? await updateClient(selectedClient.id, payload)
        : await createClient(payload);
      if (saved) {
        showToast('success', isEditModalOpen ? 'Client updated.' : 'Client added.');
        setIsAddModalOpen(false);
        setIsEditModalOpen(false);
        setFormData({ name: '', contact_person: '', phone: '', email: '', address: '' });
      } else {
        showToast('error', 'Save not confirmed. Refresh and check the client directory before retrying.');
      }
    } catch {
      showToast('error', 'Save not confirmed. Refresh and check the client directory before retrying.');
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
      if (await deleteClient(pendingDelete.id)) {
        showToast('success', 'Client removed.');
        setPendingDelete(null);
      } else {
        showToast('error', 'Removal not confirmed. Check linked projects and invoices, then refresh before retrying.');
        await refresh();
      }
    } catch {
      showToast('error', 'Removal not confirmed. Refresh the directory before retrying.');
    } finally {
      deleteLock.current = false;
      setIsDeleting(false);
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Client billing"
          title="Client Directory"
          description={`${clients.length} client account(s). Review contacts, projects and billing at a glance.`}
          action={<Button variant="primary" size="sm" onClick={() => {
            setFormData({ name: '', contact_person: '', phone: '', email: '', address: '' });
            setIsAddModalOpen(true);
          }} leftIcon={<Plus className="w-4 h-4" />}>Add Client</Button>}
        />
        <WorkspaceFilters title="Find clients" summary={<FilterSummary count={filteredClients.length} itemName="client" active={Boolean(searchQuery)} onClear={() => setSearchQuery('')} />}>
          <div className="max-w-md">
            <Input label="Search clients" placeholder="Search client name, representative, address..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
          </div>
        </WorkspaceFilters>

        {/* Client Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-fr">
          {filteredClients.map((client) => {
            const clientProjects = projects.filter((p) => p.client_id === client.id);
            const clientInvoices = invoices.filter((i) => i.client_id === client.id);
            const totalBilled = clientInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
            const totalPaid = clientInvoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);

            return (
              <div
                key={client.id}
                className="h-full min-w-0 bg-white rounded-xl p-4 sm:p-5 border border-surface-border/80 transition-all flex flex-col justify-between"
              >
                <div className="space-y-4 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-lg font-bold text-navy truncate">{client.name}</h3>
                      <div className="text-xs text-ink-secondary mt-0.5 truncate">
                        Attn: <span className="font-semibold text-navy">{client.contact_person}</span>
                      </div>
                    </div>

                    <div className="flex items-center space-x-1">
                      <button
                        type="button"
                        aria-label={`Edit ${client.name}`}
                        title="Edit client"
                        onClick={() => {
                          setSelectedClient(client);
                          setFormData({
                            name: client.name,
                            contact_person: client.contact_person,
                            phone: client.phone,
                            email: client.email,
                            address: client.address,
                          });
                          setIsEditModalOpen(true);
                        }}
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 inline-flex items-center justify-center rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${client.name}`}
                        title="Delete client"
                        onClick={() => setPendingDelete({ id: client.id, name: client.name })}
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 inline-flex items-center justify-center rounded-lg text-status-danger hover:bg-status-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-danger/25"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Contact info */}
                  <div className="space-y-2 text-xs text-ink-secondary bg-surface-inset/40 p-3 rounded-2xl border border-surface-border/60">
                    <div className="flex min-w-0 items-center gap-2">
                      <Phone className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span className="min-w-0 break-words font-mono text-navy">{client.phone}</span>
                    </div>
                    <div className="flex min-w-0 items-start gap-2">
                      <Mail className="w-3.5 h-3.5 text-navy shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">{client.email}</span>
                    </div>
                    <div className="flex min-w-0 items-start gap-2">
                      <MapPin className="w-3.5 h-3.5 text-navy shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">{client.address}</span>
                    </div>
                  </div>

                  {/* Active Projects */}
                  <div>
                    <div className="text-xs font-medium text-ink-secondary mb-1.5">
                      Engaged Projects ({clientProjects.length})
                    </div>
                    {clientProjects.length === 0 && <p className="text-xs text-ink-muted">No projects linked.</p>}
                    <div className="space-y-1">
                      {clientProjects.map((p) => (
                        <div
                          key={p.id}
                          className="min-w-0 text-xs font-semibold text-navy bg-surface px-2.5 py-1.5 rounded-lg border border-surface-border flex items-center justify-between gap-2"
                        >
                          <span className="min-w-0 truncate">{p.name}</span>
                          <Badge variant="navy" size="sm">
                            {p.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Footer Billing Metrics */}
                <div className="mt-6 pt-4 border-t border-surface-border/60 flex items-center justify-between text-xs">
                  <div>
                    <div className="text-ink-secondary">Total Invoiced</div>
                    <div className="font-bold text-navy text-sm">{formatPeso(totalBilled)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-ink-secondary">Total Settled</div>
                    <div className="font-bold text-status-success text-sm">{formatPeso(totalPaid)}</div>
                  </div>
                </div>
              </div>
            );
          })}

          {filteredClients.length === 0 && (
            <div className="md:col-span-2 bg-white rounded-xl border border-surface-border">
              <EmptyState
                title="No clients to show"
                description={
                  clients.length === 0
                    ? 'Register a client to start issuing invoices and payment requests.'
                    : 'No client matches the current search.'
                }
                action={
                  clients.length === 0 ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => { setFormData({ name: '', contact_person: '', phone: '', email: '', address: '' }); setIsAddModalOpen(true); }}
                      leftIcon={<Plus className="w-3.5 h-3.5" />}
                    >
                      Register Client
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* ADD / EDIT CLIENT MODAL */}
      <Modal
        isOpen={isAddModalOpen || isEditModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setIsEditModalOpen(false);
        }}
        dismissOnBackdrop={!isSaving}
        dismissOnEscape={!isSaving}
        showCloseButton={!isSaving}
        title={isEditModalOpen ? 'Edit Client Record' : 'Register New Client'}
        description="Maintain client contact information and project linkages."
      >
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <Input
            label="Client / Company Name"
            placeholder="e.g. Dr. Eduardo & Maria Laurel"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />

          <Input
            label="Contact Person / Representative"
            placeholder="e.g. Dr. Eduardo Laurel"
            value={formData.contact_person}
            onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Contact Number"
              placeholder="+63 917 842 1190"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              required
            />

            <Input
              label="Email Address"
              type="email"
              placeholder="eduardo@medbatangas.ph"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              required
            />
          </div>

          <Input
            label="Billing / Residence Address"
            placeholder="e.g. Ayala Greenfield Estates, Calamba / Batangas"
            value={formData.address}
            onChange={(e) => setFormData({ ...formData, address: e.target.value })}
            required
          />

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
              {isSaving ? 'Saving…' : isEditModalOpen ? 'Save Changes' : 'Create Client'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)}
        title="Remove client" description={pendingDelete ? `Remove ${pendingDelete.name}? Linked projects or invoices may prevent removal. This cannot be undone.` : ''}
        role="alertdialog" maxWidth="sm" dismissOnBackdrop={false} dismissOnEscape={!isDeleting} showCloseButton={!isDeleting}>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={isDeleting} onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button type="button" variant="danger" isLoading={isDeleting} onClick={confirmDelete}>{isDeleting ? 'Removing…' : 'Remove client'}</Button>
        </div>
      </Modal>
    </AppShell>
  );
}
