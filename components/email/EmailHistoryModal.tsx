'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { createClient } from '@/lib/supabase/client';
import { useDataStore } from '@/lib/data/store';
import type { EmailLog, EmailLogStatus } from '@/types';

interface EmailHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  invoiceId: string | null;
  invoiceNumber?: string;
}

const STATUS_META: Record<EmailLogStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  pending: { label: 'Pending or unconfirmed', variant: 'warning' },
  accepted: { label: 'Accepted by mail server', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  delivered: { label: 'Delivered (provider-confirmed)', variant: 'success' },
  bounced: { label: 'Bounced', variant: 'danger' },
};

/**
 * Per-invoice email history. Each row shows the EXACT stored snapshot of
 * what was sent — historical content never changes when the reusable
 * template is edited later.
 */
export const EmailHistoryModal: React.FC<EmailHistoryModalProps> = ({
  isOpen,
  onClose,
  invoiceId,
  invoiceNumber,
}) => {
  const supabase = useMemo(() => createClient(), []);
  const { users } = useDataStore();
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<'html' | 'text'>('text');

  useEffect(() => {
    if (!isOpen || !invoiceId) return;
    let active = true;
    setIsLoading(true);
    setLoadError(false);
    setLogs([]);
    setExpandedId(null);

    supabase
      .from('email_logs')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false })
      .then(({ data, error }: { data: unknown; error: unknown }) => {
        if (active) {
          if (error || !Array.isArray(data)) setLoadError(true);
          else setLogs(data as EmailLog[]);
          setIsLoading(false);
        }
      }, () => { if (active) { setLoadError(true); setIsLoading(false); } });

    return () => {
      active = false;
    };
  }, [isOpen, invoiceId, supabase]);

  const senderName = (userId: string | null) =>
    users.find((u) => u.id === userId)?.name || 'Unknown user';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Email History${invoiceNumber ? ` — ${invoiceNumber}` : ''}`}
      description="Exact stored snapshots of every billing email attempt for this invoice."
      maxWidth="full"
    >
      {isLoading ? (
        <div className="p-8 text-center text-xs text-ink-secondary">Loading email history…</div>
      ) : loadError ? (
        <div role="alert" className="p-8 text-center text-xs text-ink-secondary">Could not load email history. Close and reopen it to try again; do not assume no email was sent.</div>
      ) : logs.length === 0 ? (
        <div className="p-8 text-center text-xs text-ink-secondary">
          No billing email attempts are recorded here for this invoice.
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          {logs.map((log) => {
            const meta = STATUS_META[log.status] || STATUS_META.pending;
            const isExpanded = expandedId === log.id;
            return (
              <div key={log.id} className="rounded-2xl border border-surface-border bg-white overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  className="w-full p-4 text-left hover:bg-slate-50/60 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center flex-wrap gap-2">
                        <Badge variant={meta.variant} size="sm">{meta.label}</Badge>
                        <span className="font-mono text-[11px] text-ink-secondary">
                          {log.template_type} · v{log.template_version}
                        </span>
                      </div>
                      <div className="font-bold text-navy truncate">{log.subject}</div>
                      <div className="text-ink-secondary">
                        To <span className="font-mono text-navy">{log.recipient}</span> · Requested by{' '}
                        <span className="font-semibold text-navy">{senderName(log.sent_by)}</span>
                      </div>
                      {log.status === 'accepted' && log.provider_message_id && (
                        <div className="font-mono text-[10px] text-ink-muted break-all">
                          SMTP Message ID: {log.provider_message_id}
                        </div>
                      )}
                      {log.status === 'pending' && <div className="text-status-danger text-[11px]">The outcome may be unconfirmed. Check the mail server before sending again.</div>}
                      {log.error_message && (
                        <div className="text-status-danger text-[11px]">Error: {log.error_message}</div>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 shrink-0 text-right">
                      <div>
                        <div className="font-semibold text-navy">
                          {new Date(log.sent_at || log.created_at).toLocaleDateString('en-PH', {
                            month: 'short', day: 'numeric', year: 'numeric',
                          })}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {new Date(log.sent_at || log.created_at).toLocaleTimeString('en-PH', {
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </div>
                      </div>
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-ink-secondary" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-ink-secondary" />
                      )}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-surface-border/70 p-4 space-y-3 bg-surface-inset/40">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-navy uppercase text-[11px] tracking-wider">
                        Stored Email Snapshot
                      </span>
                      <div className="flex items-center space-x-1">
                        <button
                          type="button"
                          onClick={() => setExpandedTab('text')}
                          className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                            expandedTab === 'text'
                              ? 'bg-navy text-white'
                              : 'bg-white border border-surface-border text-ink-secondary hover:text-navy'
                          }`}
                        >
                          Plain Text
                        </button>
                        <button
                          type="button"
                          onClick={() => setExpandedTab('html')}
                          className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                            expandedTab === 'html'
                              ? 'bg-navy text-white'
                              : 'bg-white border border-surface-border text-ink-secondary hover:text-navy'
                          }`}
                        >
                          HTML
                        </button>
                      </div>
                    </div>

                    {expandedTab === 'text' ? (
                      <pre className="w-full max-h-72 overflow-auto rounded-xl border border-surface-border bg-white p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-ink-primary">
                        {log.body_text}
                      </pre>
                    ) : (
                      <iframe
                        title="Stored HTML email snapshot"
                        sandbox=""
                        srcDoc={log.body_html}
                        className="w-full h-72 rounded-xl border border-surface-border bg-white"
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
};
