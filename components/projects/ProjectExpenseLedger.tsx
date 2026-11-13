'use client';
import React from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatPeso } from '@/lib/email/format';
import { useExpenseLedger } from '@/lib/projects/useExpenseLedger';
import { confirmedRentalPreviewEnabled } from '@/lib/finance/featureAvailability';
import { ConfirmedRentals } from '@/components/projects/ConfirmedRentals';

export function ProjectExpenseLedger({projectId,userId,onRefreshTotals}:{projectId:string;userId:string|undefined;onRefreshTotals:()=>void}) {
 const ledger=useExpenseLedger(userId,true,projectId,true);
 if(!userId) return <p role="status" className="text-xs text-ink-secondary">Sign in to view recorded expenses.</p>;
 return <div className="animate-panel-enter animate-panel-lift space-y-4">
  <div className="flex flex-wrap items-center justify-between gap-2">
   <h3 className="font-bold text-navy text-sm">Site Disbursements &amp; Cost Ledger</h3>
   <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={()=>{ledger.reload();onRefreshTotals()}}>Refresh ledger</Button><Link href="/expenses"><Button variant="primary" size="sm" leftIcon={<Sparkles className="w-3.5 h-3.5" />}>Record Expense</Button></Link></div>
  </div>
  <p className="text-xs text-ink-secondary">Recorded expense entries only, newest first. Payroll and rentals appear only if already recorded as expenses; their automatic integration is not yet implemented. Pages and totals can change as records are edited; refresh to review the latest data.</p>
  {confirmedRentalPreviewEnabled() && <ConfirmedRentals projectId={projectId} userId={userId} />}
  <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
   <div className="divide-y divide-surface-border/70">
    {ledger.items.map(exp=><div key={exp.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
     <div className="min-w-0"><div className="font-bold text-xs sm:text-sm text-navy break-words">{exp.description}</div><div className="text-xs text-ink-secondary mt-0.5">Category: {exp.category} · Date: {exp.expense_date}</div>{exp.notes && <div className="text-[11px] text-ink-muted mt-0.5 whitespace-pre-wrap break-words">{exp.notes}</div>}</div>
     <div className="sm:text-right"><div className="text-sm font-bold text-navy">{formatPeso(exp.amount)}</div><Badge variant="navy" size="sm" className="mt-1">Recorded</Badge></div>
    </div>)}
    {ledger.loading && <p role="status" className="p-4 text-xs text-ink-secondary">Loading expense entries…</p>}
    {ledger.error && <div role="alert" className="p-4 text-xs text-status-danger">Could not load the expense ledger. <Button variant="secondary" size="sm" onClick={ledger.reload}>Reload ledger</Button></div>}
    {!ledger.loading && !ledger.error && ledger.items.length===0 && <p className="p-8 text-center text-xs text-ink-secondary">No recorded expenses found for this project.</p>}
    {ledger.hasMore && !ledger.error && <div className="p-4"><Button variant="secondary" size="sm" disabled={ledger.loading} onClick={ledger.loadMore}>Show older expenses</Button><span className="ml-2 text-xs text-ink-secondary">{ledger.items.length} entries loaded</span></div>}
   </div>
  </div>
 </div>;
}
