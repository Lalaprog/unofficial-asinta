'use client';

import React, { useState } from 'react';
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
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export default function ClientsPage() {
  const { clients, projects, invoices, createClient, updateClient, deleteClient } = useDataStore();

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

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return;

    const created = await createClient({
      name: formData.name,
      contact_person: formData.contact_person || formData.name,
      phone: formData.phone || '+63 917 000 0000',
      email: formData.email || 'client@asinta.ph',
      address: formData.address || 'Batangas',
    });

    if (created) {
      setIsAddModalOpen(false);
      setFormData({ name: '', contact_person: '', phone: '', email: '', address: '' });
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClient) return;

    const updated = await updateClient(selectedClient.id, formData);
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
    await deleteClient(target.id);
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                Client Relations
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">
                {clients.length} Registered Accounts
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Client Directory & Accounts
            </h1>
          </div>

          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setFormData({ name: '', contact_person: '', phone: '', email: '', address: '' });
              setIsAddModalOpen(true);
            }}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            Add Client Account
          </Button>
        </div>

        {/* Search */}
        <div className="max-w-md">
          <Input
            placeholder="Search client name, representative, address..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="w-4 h-4" />}
          />
        </div>

        {/* Client Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 auto-rows-fr">
          {filteredClients.map((client) => {
            const clientProjects = projects.filter((p) => p.client_id === client.id);
            const clientInvoices = invoices.filter((i) => i.client_id === client.id);
            const totalBilled = clientInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
            const totalPaid = clientInvoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);

            return (
              <div
                key={client.id}
                className="h-full min-w-0 bg-white rounded-3xl p-6 border border-surface-border/80 shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)] hover:shadow-[10px_10px_24px_rgba(11,31,58,0.09),-10px_-10px_24px_rgba(255,255,255,1)] transition-all flex flex-col justify-between"
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
                        className="p-1.5 rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(client.id, client.name)}
                        className="p-1.5 rounded-lg text-status-danger hover:bg-status-danger-bg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Contact info */}
                  <div className="space-y-2 text-xs text-ink-secondary bg-surface-inset/40 p-3 rounded-2xl border border-surface-border/60">
                    <div className="flex items-center space-x-2">
                      <Phone className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span className="font-mono text-navy">{client.phone}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Mail className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span>{client.email}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <MapPin className="w-3.5 h-3.5 text-navy shrink-0" />
                      <span>{client.address}</span>
                    </div>
                  </div>

                  {/* Active Projects */}
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wider text-ink-secondary mb-1.5">
                      Engaged Projects ({clientProjects.length})
                    </div>
                    <div className="space-y-1">
                      {clientProjects.map((p) => (
                        <div
                          key={p.id}
                          className="text-xs font-semibold text-navy bg-slate-50 px-2.5 py-1.5 rounded-xl border border-slate-200/80 flex items-center justify-between"
                        >
                          <span>{p.name}</span>
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
                    <div className="font-bold text-navy text-sm">₱{totalBilled.toLocaleString()}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-ink-secondary">Total Settled</div>
                    <div className="font-bold text-status-success text-sm">₱{totalPaid.toLocaleString()}</div>
                  </div>
                </div>
              </div>
            );
          })}

          {filteredClients.length === 0 && (
            <div className="md:col-span-2 bg-white rounded-3xl border border-surface-border">
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
                      onClick={() => setIsAddModalOpen(true)}
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
        title={isEditModalOpen ? 'Edit Client Record' : 'Register New Client'}
        description="Maintain client contact information and project linkages."
      >
        <form onSubmit={isEditModalOpen ? handleEditSubmit : handleAddSubmit} className="space-y-4 text-xs">
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

          <div className="grid grid-cols-2 gap-4">
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
              variant="secondary"
              onClick={() => {
                setIsAddModalOpen(false);
                setIsEditModalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              {isEditModalOpen ? 'Save Changes' : 'Create Client'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(pendingDelete)}
        title="Remove client"
        message={pendingDelete ? `Remove ${pendingDelete.name}? This cannot be undone.` : ''}
        confirmLabel="Remove client"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </AppShell>
  );
}
