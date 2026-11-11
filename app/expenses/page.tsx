'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { useToast } from '@/components/ui/Toast';
import { createClient } from '@/lib/supabase/client';
import { ExpenseCategory, type Expense, type ExpenseLineItem } from '@/types';
import { ExpenseItemsEditor } from '@/components/expenses/ExpenseItemsEditor';
import { ReceiptPhotoViewer } from '@/components/expenses/ReceiptPhotoViewer';
import { ReceiptInbox } from '@/components/expenses/ReceiptInbox';
import { ExpenseDetailsModal } from '@/components/expenses/ExpenseDetailsModal';
import { loadExpenseDraft, saveExpenseDraft, deleteExpenseDraft } from '@/lib/expenses/draftStore';
import { stableDraftJson, type SavedDraftPayload, type SavedDraftRow } from '@/lib/expenses/savedDraft';
import { itemInputs, prepareExpenseItems, type ItemInput } from '@/lib/expenses/items';
import {
  Plus,
  Search,
  Sparkles,
  CheckCircle2,
  Camera,
  Image as ImageIcon,
  Check,
  Bot,
  Loader2,
  AlertTriangle,
  ScanLine,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { AICategorizationResult } from '@/lib/ai/groq';
import {
  RECEIPT_BUCKET,
  buildReceiptObjectPath,
  createReceiptSignedUrl,
  validateReceiptFile,
} from '@/lib/supabase/receipts';
import { formatPeso, formatPesoCompact } from '@/lib/email/format';
import type { ExpenseDraft } from '@/lib/ai/draft';
import {
  buildExpenseWarnings,
  findLedgerDuplicates,
  findMissingReceipts,
  type ExpenseWarningSummary,
} from '@/lib/expenses/anomalies';
import { EXPENSE_CATEGORY_LABELS } from '@/lib/ai/categories';
import { resolveReceiptForSubmission } from '@/lib/expenses/receiptSubmission';
import { VISION_MAX_IMAGE_BYTES } from '@/lib/ai/models';
import { useQuickAction } from '@/lib/mobile/quickActions';
import { formatRetryWait, validRetryAfter } from '@/lib/ai/cooldown';

export default function ExpensesPage() {
  const { user, isFounder, assurance, isLoading: authLoading } = useAuth();
  const {
    expenses,
    isLoaded,
    projects,
    createExpense,
    updateExpense,
    createAdvance,
    workers,
  } = useDataStore();
  const { showToast } = useToast();
  const supabase = React.useMemo(() => createClient(), []);

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');

  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedReceiptUrl, setSelectedReceiptUrl] = useState<string | null>(null);
  const [isPhotoViewerOpen, setPhotoViewerOpen] = useState(false);
  const [savedDraft, setSavedDraft] = useState<SavedDraftRow | null>(null);
  const [draftLoadState, setDraftLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isOpeningDraft, setIsOpeningDraft] = useState(false);
  const [showCloseDraft, setShowCloseDraft] = useState(false);
  const [showDiscardDraft, setShowDiscardDraft] = useState(false);
  const draftSaveLock = React.useRef(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [itemRows, setItemRows] = useState<ItemInput[]>([]);

  // Form State
  const [formData, setFormData] = useState({
    project_id: '',
    description: '',
    details: '',
    amount: '',
    category: 'materials' as ExpenseCategory | '',
    expense_date: new Date().toISOString().split('T')[0],
    notes: '',
    receipt_url: '' as string | null,
    vendor: '',
  });

  // AI Assistant Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiResult, setAiResult] = useState<AICategorizationResult | null>(null);
  const [aiAccepted, setAiAccepted] = useState(false);

  // Receipt upload / submission state
  const [isUploadingReceipt, setIsUploadingReceipt] = useState(false);
  const [isLoadingReceipt, setIsLoadingReceipt] = useState(false);
  const [receiptFileName, setReceiptFileName] = useState<string | null>(null);
  /**
   * A receipt photo remains local until explicitly saving a draft or expense.
   */
  const [pendingReceiptFile, setPendingReceiptFile] = useState<File | null>(null);
  const [pendingReceiptPreview, setPendingReceiptPreview] = useState<string | null>(null);

  // Draft from a line of text or a receipt photo.
  const [quickText, setQuickText] = useState('');
  const [isDrafting, setIsDrafting] = useState(false);
  const [receiptLimitNotice, setReceiptLimitNotice] = useState(false);
  const [receiptRetryAt, setReceiptRetryAt] = useState<number | null>(null);
  const [retryClock, setRetryClock] = useState(0);
  React.useEffect(() => {
    if (!receiptRetryAt) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setRetryClock(now);
      if (now >= receiptRetryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [receiptRetryAt]);
  const receiptRetrySeconds = receiptRetryAt ? Math.max(0, Math.ceil((receiptRetryAt - retryClock) / 1000)) : 0;

  const [receiptToConfirm, setReceiptToConfirm] = useState<File | null>(null);
  const [confirmNewTextDraft, setConfirmNewTextDraft] = useState(false);
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [draftWarnings, setDraftWarnings] = useState<ExpenseWarningSummary | null>(null);
  const [draftInputKind, setDraftInputKind] = useState<'text' | 'receipt' | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftExtractedText, setDraftExtractedText] = useState<string | null>(null);
  const [contextWarnings, setContextWarnings] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const expenseSubmitLock = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!user?.id) { setSavedDraft(null); setDraftLoadState('loading'); return; }
    setDraftLoadState('loading');
    void loadExpenseDraft(supabase, user.id).then(result => {
      if (cancelled) return;
      if (result.ok) { setSavedDraft(result.value); setDraftLoadState('ready'); }
      else { setSavedDraft(null); setDraftLoadState('error'); }
    });
    return () => { cancelled = true; };
  }, [supabase, user?.id]);

  React.useEffect(() => {
    if (!draft) return;
    const amount = Number(formData.amount);
    setDraftWarnings(buildExpenseWarnings({amount:Number.isFinite(amount) ? amount : 0, expenseDate:formData.expense_date || new Date().toISOString().slice(0, 10), vendor:formData.vendor || null, projectId:formData.project_id, category:formData.category || 'other'}, expenses));
  }, [draft, formData.amount, formData.expense_date, formData.vendor, formData.project_id, formData.category, expenses]);

  const hasUnfinishedEntry = Boolean(formData.project_id || formData.description || formData.details || itemRows.length || formData.amount || formData.vendor || formData.notes || formData.receipt_url || pendingReceiptFile || draft || formData.category !== 'materials' || formData.expense_date !== new Date().toISOString().split('T')[0]);
  const snapshot = (receiptPath = formData.receipt_url): SavedDraftPayload => ({ version:1, form:{...formData, receipt_url:receiptPath}, rows:itemRows, receiptFileName, draft, draftInputKind, draftModel, draftExtractedText, aiResult, aiAccepted, contextWarnings });
  const unchangedSavedDraft = savedDraft && activeDraftId === savedDraft.draft_id && !pendingReceiptFile && stableDraftJson(snapshot()) === stableDraftJson(savedDraft.payload);

  React.useEffect(() => {
    if (!hasUnfinishedEntry || unchangedSavedDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnfinishedEntry, unchangedSavedDraft]);

  const resetEntry = () => {
    setFormData({ project_id:'', description:'', details:'', amount:'', category:'materials', expense_date:new Date().toISOString().split('T')[0], notes:'', receipt_url:null, vendor:'' });
    setItemRows([]); setReceiptFileName(null); setAiResult(null); setAiAccepted(false);
    setDraft(null); setDraftWarnings(null); setDraftInputKind(null); setDraftModel(null); setDraftExtractedText(null); setContextWarnings([]);
    setPendingReceiptFile(null); setPendingReceiptPreview(previous => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return null; });
    setActiveDraftId(null);
  };

  const resumeDraft = async () => {
    if (!savedDraft || isOpeningDraft) return;
    if (hasUnfinishedEntry && activeDraftId === savedDraft.draft_id) { setIsAddModalOpen(true); return; }
    if (hasUnfinishedEntry) { showToast('info', 'Continue or discard the unfinished entry before opening the saved draft.'); return; }
    setIsOpeningDraft(true);
    try {
      const {form,rows,receiptFileName:filename,draft:reading,draftInputKind:kind,draftModel:model,draftExtractedText:text,aiResult:ai,aiAccepted:accepted,contextWarnings:warnings} = savedDraft.payload;
      let url:string | null = null;
      if (form.receipt_url) {
        const signed = await createReceiptSignedUrl(supabase, form.receipt_url);
        url = signed.url;
        if (!url) showToast('error', 'The draft is available, but its receipt photo could not be opened. Try again before recording the expense.');
      }
      setFormData(form); setItemRows(rows); setReceiptFileName(filename); setDraft(reading); setDraftInputKind(kind); setDraftModel(model); setDraftExtractedText(text); setAiResult(ai); setAiAccepted(accepted);
      setDraftWarnings(null); setContextWarnings(warnings); setPendingReceiptFile(null);
      setPendingReceiptPreview(previous => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return url; });
      setActiveDraftId(savedDraft.draft_id); setIsAddModalOpen(true);
    } finally { setIsOpeningDraft(false); }
  };

  const handleSaveDraft = async (closeAfter = false) => {
    if (draftSaveLock.current || !user || draftLoadState !== 'ready' || isUploadingReceipt || isSubmitting) {
      if (draftLoadState === 'error') showToast('error', 'Saved drafts are unavailable. Refresh before trying to save a draft.');
      return;
    }
    draftSaveLock.current = true; setIsSavingDraft(true);
    try {
      let receiptPath = formData.receipt_url;
      if (pendingReceiptFile) {
        receiptPath = await uploadReceiptFile(pendingReceiptFile);
        if (!receiptPath) { showToast('error', 'The draft was not saved because the photo could not be uploaded. Your entry is still here.'); return; }
        setFormData(previous => ({...previous, receipt_url:receiptPath})); setPendingReceiptFile(null);
      }
      const id = activeDraftId || crypto.randomUUID();
      // Keep this identity even if the response is lost: the server may have
      // committed the draft, and a later expense must use the same ID.
      setActiveDraftId(id);
      const result = await saveExpenseDraft(supabase, user.id, savedDraft, id, snapshot(receiptPath));
      if (!result.ok) { showToast('error', result.message); return; }
      setSavedDraft(result.value); setActiveDraftId(id); setShowCloseDraft(false);
      if (closeAfter) setIsAddModalOpen(false);
      showToast('success', 'Draft saved. It is not an expense yet.');
    } catch { showToast('error', 'The draft save could not be confirmed. Refresh and check it before retrying.'); }
    finally { draftSaveLock.current = false; setIsSavingDraft(false); }
  };
  const requestCloseEntry = () => {
    if (isSubmitting || isUploadingReceipt || isSavingDraft) return;
    if (hasUnfinishedEntry && !unchangedSavedDraft) setShowCloseDraft(true);
    else setIsAddModalOpen(false);
  };
  const discardSavedDraft = async () => {
    if (!savedDraft || !user || draftSaveLock.current) return;
    draftSaveLock.current = true; setIsSavingDraft(true);
    try {
      const result = await deleteExpenseDraft(supabase, user.id, savedDraft);
      if (!result.ok) { showToast('error', result.message); return; }
      setSavedDraft(null); setShowDiscardDraft(false);
      showToast('success', 'Saved draft discarded. No expense was changed.');
    } finally { draftSaveLock.current = false; setIsSavingDraft(false); }
  };
  const openEntry = () => {
    if (savedDraft && !hasUnfinishedEntry) void resumeDraft();
    else setIsAddModalOpen(true);
  };

  useQuickAction('/expenses', ['expense-manual', 'expense-scan', 'expense-describe'], isFounder && assurance === 'ready' && !authLoading && isLoaded && draftLoadState !== 'loading', (action) => {
    if (draftLoadState === 'error') { showToast('error', 'Saved drafts could not be checked. Refresh before starting a shortcut.'); return; }
    if (action === 'expense-manual') { openEntry(); return; }
    if (isAddModalOpen) { showToast('info', 'Finish or save your current expense before starting another.'); return; }
    const target = document.getElementById(action === 'expense-scan' ? 'quick-receipt-input' : 'quick-expense-description');
    target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target?.focus({ preventScroll: true });
    if (action === 'expense-scan') showToast('info', 'Choose Scan a receipt photo to take or select a photo.');
  });

  React.useEffect(() => {
    const beforeQuickLeave = (event: Event) => {
      const destination = (event as CustomEvent<{ destination: string }>).detail.destination.split('?')[0];
      if (destination !== '/expenses' && ((hasUnfinishedEntry && !unchangedSavedDraft) || quickText.trim())) {
        if (!window.confirm('You have an unfinished expense or description. Leave and lose unsaved changes? Cancel to stay and finish or save your work.')) event.preventDefault();
      }
    };
    window.addEventListener('asinta:quick-leave', beforeQuickLeave);
    return () => window.removeEventListener('asinta:quick-leave', beforeQuickLeave);
  }, [hasUnfinishedEntry, unchangedSavedDraft, quickText]);

  // Bale confirmation. A detected advance is NEVER created automatically —
  // the Founder must name the recipient first.
  const [balePrompt, setBalePrompt] = useState<{
    description: string;
    amount: number;
    projectId: string;
    expenseDate: string;
  } | null>(null);
  const [baleWorkerId, setBaleWorkerId] = useState('');
  const [isCreatingAdvance, setIsCreatingAdvance] = useState(false);

  // Non-binding hint only: names that literally appear in the description.
  // It is never used to pre-select or auto-assign a worker.
  const mentionedWorkers = balePrompt
    ? workers.filter((worker) => {
        if (worker.removed_at) return false;
        const firstName = worker.name.toLowerCase().split(' ')[0];
        return firstName.length > 2 && balePrompt.description.toLowerCase().includes(firstName);
      })
    : [];

  // Track C checks over the whole ledger (memoised: the anomaly scan is
  // O(n²) over amounts within the duplicate window, and this is a client list
  // that only changes when the ledger reloads).
  const duplicateLookbackDays = 7;
  const receiptThreshold = 5000;
  const ledgerDuplicates = React.useMemo(
    () => findLedgerDuplicates(expenses, { windowDays: duplicateLookbackDays }),
    [expenses]
  );
  const missingReceipts = React.useMemo(
    () => findMissingReceipts(expenses, receiptThreshold),
    [expenses]
  );

  const filteredExpenses = expenses.filter((exp) => {
    const proj = projects.find((p) => p.id === exp.project_id);
    const matchesSearch =
      exp.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      proj?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (exp.notes && exp.notes.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (exp.vendor && exp.vendor.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (exp.details && exp.details.toLowerCase().includes(searchQuery.toLowerCase())) ||
      Boolean(exp.line_items?.some(item => item.name.toLowerCase().includes(searchQuery.toLowerCase())));

    const matchesCategory = categoryFilter === 'all' || exp.category === categoryFilter;
    const matchesProject = projectFilter === 'all' || exp.project_id === projectFilter;

    return matchesSearch && matchesCategory && matchesProject;
  });

  // AI Trigger
  const handleAnalyzeWithAI = async () => {
    if (!formData.description) return;
    setIsAnalyzing(true);
    try {
      const res = await fetch('/api/ai/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: formData.description,
          amount: parseFloat(formData.amount) || 0,
        }),
      });
      if (res.ok) {
        const data: AICategorizationResult = await res.json();
        setAiResult(data);
        setAiAccepted(false);
      } else {
        const body = await res.json().catch(() => null);
        showToast('error', body?.error || `AI categorization failed (HTTP ${res.status}).`);
      }
    } catch (e: any) {
      console.error('AI categorization error:', e);
      showToast('error', `AI categorization request failed: ${e?.message || 'network error'}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAcceptAISuggestion = () => {
    if (!aiResult) return;
    setFormData({
      ...formData,
      category: aiResult.category,
      notes: formData.notes
        ? `${formData.notes} (Suggestion: ${aiResult.reasoning})`
        : `Suggestion: ${aiResult.reasoning}`,
    });
    setAiAccepted(true);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (activeDraftId && expenses.some(expense => expense.id === activeDraftId)) { showToast('error', 'This draft matches a recorded expense. Check the ledger before doing anything else.'); return; }
    if (expenseSubmitLock.current || isUploadingReceipt || !formData.project_id || !formData.description || !formData.amount || !formData.expense_date || !formData.category) return;
    const parsedItems = prepareExpenseItems(itemRows);
    if (parsedItems.error) { showToast('error', parsedItems.error); return; }
    if (formData.details.length > 5000) { showToast('error', 'Keep details under 5,000 characters.'); return; }
    if (!user) {
      showToast('error', 'You must be signed in to record expenses.');
      return;
    }

    expenseSubmitLock.current = true;
    setIsSubmitting(true);
    try {
      if (savedDraft && activeDraftId === savedDraft.draft_id) {
        const latest = await loadExpenseDraft(supabase, user.id);
        if (!latest.ok || !latest.value || latest.value.draft_id !== savedDraft.draft_id || latest.value.revision !== savedDraft.revision) {
          showToast('error', 'The saved draft could not be verified or changed elsewhere. Your entry is still here; refresh and check before recording.');
          return;
        }
      }
      const amountNum = parseFloat(formData.amount);

      // Upload a local receipt before the ledger write; a saved draft may
      // already refer to a private object.
      const receipt = await resolveReceiptForSubmission(formData.receipt_url, pendingReceiptFile, uploadReceiptFile);
      if (!receipt.ok) {
        showToast('error', 'The expense was not saved because its receipt could not be uploaded. Your entry is still here.');
        return;
      }
      const receiptPath = receipt.path;
      if (!formData.receipt_url && receiptPath) {
        // Reuse the uploaded object if the expense write fails and the user retries.
        setFormData((previous) => ({ ...previous, receipt_url: receiptPath }));
      }

      /**
       * `ai_confirmed` means "the suggestion we showed is the category that was
       * saved". That is true either because the Founder pressed Accept, or
       * because they left the prefilled value untouched — both are the suggestion
       * being applied. It is never set just because a suggestion existed.
       */
      const suggestionApplied = Boolean(aiResult && (aiAccepted || aiResult.category === formData.category));

      const newExp = await createExpense({
        project_id: formData.project_id,
        description: formData.description,
        details: formData.details.trim() || null,
        line_items: parsedItems.items.length ? parsedItems.items : null,
        category: formData.category,
        amount: amountNum,
        expense_date: formData.expense_date,
        receipt_url: receiptPath,
        notes: formData.notes || null,
        vendor: formData.vendor.trim() || null,
        ai_category_suggestion: aiResult?.category || null,
        ai_bale_detection: aiResult?.isBale || false,
        ai_confirmed: suggestionApplied,
        created_by: user.id,
      }, activeDraftId || undefined);

      if (!newExp && activeDraftId) showToast('error', 'The expense could not be confirmed. Check the ledger before retrying.');
      if (newExp) {
        if (savedDraft && user && activeDraftId === savedDraft.draft_id) {
          const removed = await deleteExpenseDraft(supabase, user.id, savedDraft);
          if (removed.ok) setSavedDraft(null);
          else showToast('error', 'Expense recorded, but the saved draft could not be cleared. Refresh and check the ledger before using it again.');
        }
        showToast('success', 'Expense recorded.');
        // Track A: record what the Founder actually kept versus what we showed.
        // Counters only — no embeddings, and a failure is reported rather than
        // silently dropping the firm's history for this supplier.
        if (newExp.vendor && aiResult?.category) {
          try {
            const memoryResponse = await fetch('/api/ai/vendor-memory', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                vendor: newExp.vendor,
                suggestedCategory: aiResult.category,
                finalCategory: newExp.category,
              }),
            });
            if (!memoryResponse.ok) {
              const body = await memoryResponse.json().catch(() => null);
              showToast(
                'error',
                body?.error ||
                  'The expense was saved, but the supplier history was not updated.'
              );
            }
          } catch {
            showToast(
              'error',
              'The expense was saved, but the supplier history could not be updated (network error).'
            );
          }
        }

        // A detected bale is a *proposal*, not a write. The Founder chooses the
        // recipient in a follow-up dialog; nothing is deducted automatically.
        if (aiResult?.isBale) {
          setBalePrompt({
            description: formData.description,
            amount: amountNum,
            projectId: formData.project_id,
            expenseDate: formData.expense_date,
          });
          setBaleWorkerId('');
        }

        setIsAddModalOpen(false);
        setFormData({
          project_id: '',
          description: '',
          details: '',
          amount: '',
          category: 'materials',
          expense_date: new Date().toISOString().split('T')[0],
          notes: '',
          receipt_url: null,
          vendor: '',
        });
        setAiResult(null);
        setAiAccepted(false);
        setItemRows([]);
        setReceiptFileName(null);
        setDraft(null);
        setDraftWarnings(null);
        setDraftInputKind(null);
        setDraftModel(null);
        setDraftExtractedText(null);
        setContextWarnings([]);
        setPendingReceiptFile(null);
        setPendingReceiptPreview((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return null;
        });
      } else {
        showToast('error', 'Expense save was not confirmed. Check the ledger before trying again; your entry is still here.');
      }
    } catch {
      showToast('error', 'Could not confirm whether the expense was saved. Refresh the ledger and check before trying again.');
    } finally {
      expenseSubmitLock.current = false;
      setIsSubmitting(false);
    }
  };

  const handleDismissBalePrompt = () => {
    setBalePrompt(null);
    setBaleWorkerId('');
  };

  const handleConfirmBaleAdvance = async () => {
    if (!balePrompt || !baleWorkerId) return;
    setIsCreatingAdvance(true);
    const created = await createAdvance({
      worker_id: baleWorkerId,
      project_id: balePrompt.projectId,
      amount: balePrompt.amount,
      reason: balePrompt.description,
      date: balePrompt.expenseDate,
    });
    setIsCreatingAdvance(false);

    if (created) {
      showToast('success', 'Worker advance recorded in the Bale ledger.');
    } else {
      showToast(
        'error',
        'The expense was saved, but the worker advance could not be created. Record it from the Advances page.'
      );
    }

    handleDismissBalePrompt();
  };

  // Upload the receipt photo to the PRIVATE `receipts` bucket and persist the
  // storage PATH on expenses.receipt_url (never a URL — a public URL would leak
  // the photo to anyone holding the row). The preview mints a short-lived
  // signed URL on demand.
  const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Extension comes from the MIME allowlist, not from file.name.
    const check = validateReceiptFile(file);
    if (!check.ok || !check.extension) {
      showToast('error', check.error || 'That receipt file is not accepted.');
      e.target.value = '';
      return;
    }

    setIsUploadingReceipt(true);
    try {
      const path = await uploadReceiptFile(file);
      if (path) {
        setFormData((prev) => ({ ...prev, receipt_url: path }));
        setReceiptFileName(file.name);
        if (draftInputKind === 'receipt') {
          setDraft(null);
          setDraftWarnings(null);
          setDraftInputKind(null);
          setDraftModel(null);
          setDraftExtractedText(null);
          setContextWarnings([]);
          setAiResult(null);
          setAiAccepted(false);
          showToast('info', 'Photo replaced. The form may still contain details from the earlier scan; review them against the new photo.');
        }
        setPendingReceiptFile(null);
        setPendingReceiptPreview((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return null;
        });
        showToast('success', 'Receipt photo uploaded to private storage.');
      }
    } catch {
      showToast('error', 'The receipt upload could not be confirmed. Check your connection and try again.');
    } finally {
      setIsUploadingReceipt(false);
      // Allow re-selecting the same file after a failure.
      e.target.value = '';
    }
  };

  /**
   * Uploads one receipt photo to the private bucket and returns the storage
   * path (or null with a visible error). Shared by the manual picker and the
   * AI receipt path so both validate identically.
   */
  const uploadReceiptFile = async (file: File): Promise<string | null> => {
    const check = validateReceiptFile(file);
    if (!check.ok || !check.extension) {
      showToast('error', check.error || 'That receipt file is not accepted.');
      return null;
    }
    const path = buildReceiptObjectPath(user?.id || 'unattributed', check.extension);
    const { error: uploadError } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    });
    if (uploadError) {
      showToast('error', `Receipt upload failed: ${uploadError.message}`);
      return null;
    }
    return path;
  };

  /**
   * Opens the receipt preview. The bucket is private, so the image URL is a
   * short-lived signature minted for this session; if signing fails we say so
   * instead of rendering a broken image.
   */
  const openReceiptPreview = async (storedValue: string | null) => {
    setIsLoadingReceipt(true);
    const { url, error } = await createReceiptSignedUrl(supabase, storedValue);
    setIsLoadingReceipt(false);
    if (!url) {
      showToast('error', error || 'The receipt photo could not be loaded.');
      return;
    }
    setSelectedReceiptUrl(url);
  };

  // ---------------------------------------------------------------------------
  // Draft from a line of text or a receipt photo
  // ---------------------------------------------------------------------------

  /**
   * Applies a draft to the form and opens the confirmation modal.
   *
   * Prefill only: nothing is written here. Every field the Founder does not
   * touch is a field they have seen and accepted, and anything the extractor
   * could not verify is listed in `unresolved` instead of being filled with a
   * plausible guess.
   */
  const applyDraft = (
    nextDraft: ExpenseDraft,
    input: { kind: 'text' | 'receipt'; model?: string | null; extractedText?: string | null }
  ) => {
    setFormData((previous) => input.kind === 'receipt' ? {
      ...previous,
      description: nextDraft.description,
      details: '',
      amount: nextDraft.amount !== null ? String(nextDraft.amount) : '',
      expense_date: nextDraft.expenseDate ?? '',
      project_id: nextDraft.projectId ?? '',
      category: nextDraft.category ?? '',
      vendor: nextDraft.vendor ?? '',
      notes: '',
      receipt_url: null,
    } : {
      ...previous,
      description: nextDraft.description || previous.description,
      amount: nextDraft.amount !== null ? String(nextDraft.amount) : '',
      expense_date: nextDraft.expenseDate ?? previous.expense_date,
      project_id: nextDraft.projectId ?? previous.project_id,
      category: nextDraft.category ?? previous.category,
      vendor: nextDraft.vendor ?? previous.vendor,
      notes: nextDraft.noteEvidence
        ? previous.notes ? `${previous.notes} ${nextDraft.noteEvidence}` : nextDraft.noteEvidence
        : previous.notes,
    });

    // The draft's category is a suggestion with provenance, so it feeds the
    // same review box the manual "Analyze with Groq AI" button uses.
    setAiResult(null);
    setAiAccepted(false);
    if (nextDraft.category) {
      setAiResult({
        category: nextDraft.category,
        isBale: nextDraft.isBaleHint,
        reasoning:
          nextDraft.categorySource === 'vendor_memory'
            ? 'Suggested from your own history with this supplier.'
            : nextDraft.categorySource === 'llm'
              ? `Extracted from the ${input.kind === 'text' ? 'description' : 'receipt photo'} by the AI model.`
              : 'Suggested by the built-in rules.',
        evidence: nextDraft.evidence.slice(0, 3),
        source: nextDraft.categorySource === 'llm' ? 'llm' : 'rules',
      });
      setAiAccepted(false);
    }

    setDraft(nextDraft);
    setDraftInputKind(input.kind);
    setDraftModel(input.model ?? null);
    setDraftExtractedText(input.extractedText ?? null);
    setIsAddModalOpen(true);

    const amount = nextDraft.amount !== null ? formatPeso(nextDraft.amount) : null;
    showToast(
      'info',
      amount
        ? `Draft ready — ${amount}${nextDraft.vendor ? ` at ${nextDraft.vendor}` : ''}. Review every field, then save.`
        : 'Draft ready. The total could not be determined safely, so it was left blank — enter it yourself.'
    );
  };

  const handleDraftFromText = async (replaceEntry = false) => {
    if (!quickText.trim() || isDrafting) return;
    setIsDrafting(true);
    setDraftWarnings(null);
    setContextWarnings([]);
    try {
      const response = await fetch('/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: quickText }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.draft) {
        showToast('error', payload?.error || `Drafting failed (HTTP ${response.status}).`);
        return;
      }

      if (replaceEntry) resetEntry();
      setActiveDraftId(crypto.randomUUID());
      setContextWarnings(Array.isArray(payload.contextWarnings) ? payload.contextWarnings : []);
      const nextDraft = payload.draft as ExpenseDraft;
      setDraftWarnings(
        buildExpenseWarnings(
          {
            amount: nextDraft.amount ?? 0,
            expenseDate: nextDraft.expenseDate ?? new Date().toISOString().slice(0, 10),
            vendor: nextDraft.vendor,
            projectId: nextDraft.projectId ?? '',
            category: nextDraft.category ?? 'other',
          },
          expenses
        )
      );
      applyDraft(nextDraft, { kind: 'text' });
      setQuickText('');
    } catch (caught) {
      showToast(
        'error',
        caught instanceof Error ? `Draft request failed: ${caught.message}` : 'Draft request failed.'
      );
    } finally {
      setIsDrafting(false);
    }
  };

  const readReceiptFileAsBase64 = (file: File) =>
    new Promise<{ mediaType: string; base64: string }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The image could not be read from disk.'));
      reader.onload = () => {
        const result = String(reader.result || '');
        const match = /^data:([^;]+);base64,(.*)$/s.exec(result);
        if (!match) {
          reject(new Error('The image could not be encoded.'));
          return;
        }
        resolve({ mediaType: match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1], base64: match[2] });
      };
      reader.readAsDataURL(file);
    });

  const handleDraftFromReceipt = async (file: File) => {
    if (isDrafting) return;
    const check = validateReceiptFile(file);
    if (!check.ok || file.size > VISION_MAX_IMAGE_BYTES) {
      showToast('error', check.error || 'Receipt scanning accepts JPEG, PNG or WebP up to 4 MB. You can attach a photo up to 5 MB manually.');
      return;
    }
    if (receiptRetrySeconds > 0) return;
    setReceiptLimitNotice(false); setReceiptRetryAt(null);
    setIsDrafting(true);

    try {
      const { mediaType, base64 } = await readReceiptFileAsBase64(file);
      const response = await fetch('/api/ai/receipt-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaType, base64 }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok || !payload?.draft) {
        if (response.status === 429 || payload?.rateLimited === true) {
          const wait = validRetryAfter(payload?.retryAfterSeconds);
          setReceiptLimitNotice(true);
          if (wait) { const now = Date.now(); setRetryClock(now); setReceiptRetryAt(now + wait * 1000); }
        }
        // Honest failure: the manual path is untouched and we say so.
        showToast(
          'error',
          `${payload?.error || 'The receipt could not be read.'} No new photo was attached; you can attach it manually.`
        );
        return;
      }

      setActiveDraftId(crypto.randomUUID());
      setItemRows(itemInputs(Array.isArray(payload.items) ? payload.items as ExpenseLineItem[] : []));
      setPendingReceiptFile(file);
      setReceiptFileName(file.name);
      setPendingReceiptPreview((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(file);
      });
      setContextWarnings(Array.isArray(payload.contextWarnings) ? payload.contextWarnings : []);
      const nextDraft = payload.draft as ExpenseDraft;
      setDraftWarnings(
        buildExpenseWarnings(
          {
            amount: nextDraft.amount ?? 0,
            expenseDate: nextDraft.expenseDate ?? new Date().toISOString().slice(0, 10),
            vendor: nextDraft.vendor,
            projectId: nextDraft.projectId ?? '',
            category: nextDraft.category ?? 'other',
          },
          expenses
        )
      );
      applyDraft(nextDraft, {
        kind: 'receipt',
        model: payload.read?.model ?? null,
        extractedText: payload.read?.extractedText ?? null,
      });
    } catch (caught) {
      showToast(
        'error',
        caught instanceof Error
          ? `Receipt reading failed: ${caught.message}`
          : 'Receipt reading failed.'
      );
    } finally {
      setIsDrafting(false);
    }
  };

  const openDraftPhoto = async () => {
    if (formData.receipt_url && !pendingReceiptFile) {
      const signed = await createReceiptSignedUrl(supabase, formData.receipt_url);
      if (!signed.url) { showToast('error', 'The receipt photo could not be opened. Please try again.'); return; }
      setPendingReceiptPreview(previous => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return signed.url; });
    }
    setPhotoViewerOpen(true);
  };

  const handleRemoveReceipt = () => {
    setFormData((previous) => ({ ...previous, receipt_url: null }));
    setReceiptFileName(null);
    setPendingReceiptFile(null);
    setPendingReceiptPreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Project ledger"
          title="Site Expenses"
          description="Record and review materials, equipment and other site disbursements."
          action={
            <Button variant="primary" size="md" onClick={openEntry} leftIcon={<Plus className="w-4 h-4" />}>
              Record Expense
            </Button>
          }
        />

        {draftLoadState === 'error' && <div role="status" className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-4 text-sm text-status-warning">Saved drafts could not be checked. Refresh before saving a draft; manual expense entry still works.</div>}
        {savedDraft && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/20 bg-surface-inset p-4"><div><p className="text-sm font-bold text-navy">Saved expense draft</p><p className="text-xs text-ink-secondary">{expenses.some(expense => expense.id === savedDraft.draft_id) ? 'This draft matches a recorded expense. Check the ledger before discarding it.' : 'Review before recording. Saving a draft does not add an expense.'}</p></div><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" isLoading={isOpeningDraft} onClick={() => void resumeDraft()}>Continue draft</Button><Button type="button" size="sm" variant="ghost" onClick={() => setShowDiscardDraft(true)}>Discard draft</Button></div></div>}
        {hasUnfinishedEntry && (!savedDraft || activeDraftId !== savedDraft.draft_id) && <div className="rounded-xl border border-brand/20 bg-surface-inset p-4 text-sm text-ink-secondary">You have an unfinished entry on this page. <button type="button" onClick={() => setIsAddModalOpen(true)} className="font-semibold text-navy underline">Continue entry</button>. It is not saved until you choose Save draft or confirm the expense.</div>}

        {isFounder && assurance === 'ready' && user && <ReceiptInbox key={user.id} userId={user.id} canUse={draftLoadState === 'ready' && isLoaded && !hasUnfinishedEntry && !savedDraft && !isAddModalOpen && !isDrafting && !isSubmitting} onView={path => void openReceiptPreview(path)} onUse={item => {
          if (draftLoadState !== 'ready' || !isLoaded || hasUnfinishedEntry || savedDraft || isAddModalOpen || isDrafting || isSubmitting) return;
          setActiveDraftId(crypto.randomUUID());
          setFormData(previous => ({...previous, receipt_url:item.object_path}));
          setReceiptFileName(item.file_name);
          setPendingReceiptFile(null);
          setPendingReceiptPreview(previous => {if(previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return null;});
          setIsAddModalOpen(true);
        }} />}

        {/* ------------------------------------------------------------------
            Draft from text or a receipt photo.
            The model extracts; the Founder confirms in the modal below. Nothing
            written here reaches the ledger.
           ------------------------------------------------------------------ */}
        <div data-page-guide="draft" className="rounded-xl border border-surface-border bg-white p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-navy" />
              <span className="text-sm font-bold text-navy tracking-tight">Describe it once</span>
              <Badge variant="neutral" size="sm">
                Draft only — you confirm
              </Badge>
            </div>
            {(draftModel || draftInputKind) && (
              <span className="text-[11px] text-ink-muted">
                {draftInputKind === 'receipt'
                  ? 'Read from a receipt photo'
                  : 'Drafted from your description'}
                {draftModel ? ` · ${draftModel}` : ''}
              </span>
            )}
          </div>

          <Textarea
            id="quick-expense-description"
            label="Describe the expense"
            placeholder={'e.g. 12 bags cement @ ₱400 each, total ₱4,800, kahapon'}
            value={quickText}
            onChange={(event) => setQuickText(event.target.value)}
            rows={2}
          />

          <p className="text-xs text-ink-secondary">For each item, include quantity and price each, or state the final total. Review the amount before saving; unrelated questions are not supported.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => { if (hasUnfinishedEntry || savedDraft) setConfirmNewTextDraft(true); else void handleDraftFromText(); }}
              isLoading={isDrafting && draftInputKind !== 'receipt'}
              disabled={!quickText.trim() || isDrafting}
              leftIcon={<Sparkles className="h-3.5 w-3.5" />}
            >
              Draft expense
            </Button>

            <label className={`inline-flex min-h-11 items-center gap-2 rounded-xl border border-surface-border bg-surface-inset px-3 py-2 text-[11px] font-semibold text-navy transition-all focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2 ${receiptRetrySeconds > 0 ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-200'}`}>
              <ScanLine className="h-3.5 w-3.5" />
              <span>{isDrafting ? 'Reading…' : 'Scan a receipt photo'}</span>
              <input
                id="quick-receipt-input"
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={isDrafting || receiptRetrySeconds > 0}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) {
                    if (hasUnfinishedEntry || savedDraft) setReceiptToConfirm(file);
                    else void handleDraftFromReceipt(file);
                  }
                }}
              />
            </label>


          </div>

          {receiptLimitNotice && <div className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-3 text-sm text-status-warning">
            <span role="status">Receipt scanning is temporarily limited. Your previous entry is safe; you can attach the photo and enter details manually.</span>{' '}
            {receiptRetryAt ? <span aria-live="off">{receiptRetrySeconds > 0 ? `Try again in about ${formatRetryWait(receiptRetrySeconds)}.` : 'You can try again now; availability is not guaranteed.'}</span> : <span>Try again later; a wait time was not provided.</span>}
          </div>}
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Scanning sends the photo to Groq for reading (JPEG, PNG or WebP up to 4 MB).
            Check every suggestion against the photo. If something is unclear, enter it yourself.
            You can also attach a photo without scanning it.
          </p>
        </div>

        {/* Ledger checks — arithmetic, not AI (Track C) */}
        {(ledgerDuplicates.length > 0 || missingReceipts.length > 0) && (
          <div className="rounded-xl border border-status-warning/20 bg-status-warning-bg/60 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-status-warning" />
              <span className="text-sm font-bold text-navy">Ledger checks</span>
              <span className="text-[11px] text-ink-secondary">
                Computed from your own entries. Nothing here blocks a save.
              </span>
            </div>

            {ledgerDuplicates.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-ink-secondary">
                  Possible duplicates ({ledgerDuplicates.length})
                </div>
                <ul className="space-y-1 text-[11px] text-ink-secondary">
                  {ledgerDuplicates.slice(0, 3).map((pair) => (
                    <li key={`${pair.a.id}-${pair.b.id}`} className="rounded-xl border border-surface-border bg-white px-3 py-2">
                      <span className="font-semibold text-navy">
                        {formatPeso(Number(pair.a.amount))}
                      </span>{' '}
                      — {pair.reason} Both entries:{' '}
                      <span className="italic">
                        “{pair.a.description.slice(0, 40)}” and “{pair.b.description.slice(0, 40)}”
                      </span>
                    </li>
                  ))}
                </ul>
                {ledgerDuplicates.length > 3 && (
                  <p className="text-[10px] text-ink-muted">
                    +{ledgerDuplicates.length - 3} more pair(s). Open an entry to compare them.
                  </p>
                )}
              </div>
            )}

            {missingReceipts.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-ink-secondary">
                  Large expenses with no receipt photo ({missingReceipts.length})
                </div>
                <ul className="space-y-1 text-[11px] text-ink-secondary">
                  {missingReceipts.slice(0, 3).map((finding) => (
                    <li key={finding.expense.id} className="rounded-xl border border-surface-border bg-white px-3 py-2">
                      {finding.reason} — “{finding.expense.description.slice(0, 48)}”
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <WorkspaceFilters
          title="Find an expense"
          summary={<FilterSummary count={filteredExpenses.length} itemName="expense" active={Boolean(searchQuery) || categoryFilter !== 'all' || projectFilter !== 'all'} onClear={() => { setSearchQuery(''); setCategoryFilter('all'); setProjectFilter('all'); }} />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input
              label="Search expenses"
              placeholder="Search expense description, notes, supplier..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />

            <Select
              label="Category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              options={[
                { label: 'All Categories', value: 'all' },
                { label: 'Materials', value: 'materials' },
                { label: 'Labor', value: 'labor' },
                { label: 'Equipment', value: 'equipment' },
                { label: 'Permits', value: 'permits' },
                { label: 'Transportation', value: 'transportation' },
                { label: 'Other', value: 'other' },
              ]}
            />

            <Select
              label="Project"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="all">All Project Sites</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </WorkspaceFilters>

        {/* Expenses List */}
        <div data-page-guide="list" className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="divide-y divide-surface-border/70">
            {filteredExpenses.map((exp) => {
              const proj = projects.find((p) => p.id === exp.project_id);

              return (
                <div
                  key={exp.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-surface transition-colors"
                >
                  {/* Left info */}
                  <div className="min-w-0 max-w-xl flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-semibold text-sm text-navy">{exp.description}</span>
                      <Badge variant="navy" size="sm" className="capitalize">
                        {exp.category}
                      </Badge>
                      {exp.ai_bale_detection && (
                        <Badge variant="warning" size="sm">
                          Worker Bale
                        </Badge>
                      )}
                    </div>

                    <div className="text-xs text-ink-secondary">
                      Site: <span className="font-semibold text-navy">{proj?.name}</span> · Date:{' '}
                      {exp.expense_date}
                      {exp.vendor ? (
                        <>
                          {' '}
                          · Supplier: <span className="font-semibold text-navy">{exp.vendor}</span>
                        </>
                      ) : null}
                    </div>

                    {exp.notes && (
                      <div className="text-xs text-ink-muted italic">{exp.notes}</div>
                    )}

                    {/* Track C flags, stated with their arithmetic. */}
                    {(() => {
                      const duplicate = ledgerDuplicates.find(
                        (pair) => pair.a.id === exp.id || pair.b.id === exp.id
                      );
                      const missingReceipt = missingReceipts.find(
                        (finding) => finding.expense.id === exp.id
                      );
                      if (!duplicate && !missingReceipt) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                          {duplicate && (
                            <span className="inline-flex items-center gap-1 rounded-md border border-status-danger/20 bg-status-danger-bg px-2 py-0.5 font-semibold text-status-danger">
                              <AlertTriangle className="h-3 w-3" />
                              Possible duplicate — {duplicate.reason}
                            </span>
                          )}
                          {missingReceipt && (
                            <span className="inline-flex items-center gap-1 rounded-md border border-status-warning/20 bg-status-warning-bg px-2 py-0.5 font-semibold text-status-warning">
                              <AlertTriangle className="h-3 w-3" />
                              No receipt photo over ₱{receiptThreshold.toLocaleString('en-PH')}
                            </span>
                          )}
                        </div>
                      );
                    })()}

                    {/* Entry provenance — states what actually happened. */}
                    <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-ink-secondary">
                      <span className="inline-flex items-center space-x-1 text-status-success font-semibold bg-status-success-bg px-2 py-0.5 rounded-md border border-status-success/20">
                        <CheckCircle2 className="w-3 h-3 text-status-success" />
                        <span>
                          {/* Requires a recorded suggestion AND confirmation: `ai_confirmed`
                              was previously hardcoded true, so on its own it would claim
                              a suggestion was applied to rows that never had one. */}
                          {exp.ai_category_suggestion && exp.ai_confirmed
                            ? 'Suggestion applied'
                            : 'Entered manually'}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Right: Amount & Receipt Preview */}
                  <div className="flex items-center justify-between lg:justify-end space-x-4">
                    <div className="text-left lg:text-right">
                      <div className="text-base font-extrabold text-navy">{formatPesoCompact(exp.amount)}</div>
                      <div className="text-[11px] text-ink-secondary">Disbursed</div>
                    </div>

                    <Button variant="secondary" size="sm" onClick={() => setSelectedExpense(exp)}>View details</Button>
                    {exp.receipt_url ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={isLoadingReceipt}
                        onClick={() => openReceiptPreview(exp.receipt_url)}
                        leftIcon={<ImageIcon className="w-3.5 h-3.5 text-navy" />}
                      >
                        Receipt Photo
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-muted italic px-2">No photo</span>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredExpenses.length === 0 && (
              <EmptyState
                title="No expenses to show"
                description={
                  expenses.length === 0
                    ? 'Record your first site disbursement to start the ledger.'
                    : 'No expense matches the current search or filters.'
                }
                action={
                  expenses.length === 0 ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={openEntry}
                      leftIcon={<Plus className="w-3.5 h-3.5" />}
                    >
                      Record Expense
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
        </div>
      </div>

      {/* RECORD EXPENSE MODAL WITH GROQ AI ASSISTANT */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={requestCloseEntry}
        dismissOnBackdrop={!isSubmitting && !isUploadingReceipt && !isSavingDraft}
        dismissOnEscape={!isSubmitting && !isUploadingReceipt && !isSavingDraft}
        showCloseButton={!isSubmitting && !isUploadingReceipt && !isSavingDraft}
        title="Record Site Expense"
        description="Review and correct every field before saving."
        maxWidth="5xl"
        presentation="workspace"
      >
        <p role="status" className="mb-4 text-xs text-ink-secondary">{unchangedSavedDraft ? 'Draft saved. Changes after this point need saving again.' : 'Unsaved changes — choose Save draft before leaving to continue later.'}</p>
        <form onSubmit={handleAddSubmit}><fieldset disabled={isSavingDraft || isSubmitting || isUploadingReceipt} className="min-w-0"><div className={draft ? "grid min-w-0 gap-5 text-sm lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start lg:gap-6" : "min-w-0 space-y-4 text-sm"}>
          {/* DRAFT REVIEW — what the AI read, what the rules verified, and what
              is still missing. The Founder confirms; nothing is saved yet. */}
          {draft && (
            <div className="min-w-0 space-y-3 rounded-2xl border border-status-info/20 bg-status-info-bg/50 p-4 lg:sticky lg:top-0 lg:max-h-[calc(92dvh-10rem)] lg:overflow-y-auto lg:overscroll-contain">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 text-navy font-bold">
                  <Bot className="h-4 w-4" />
                  <span>
                    {draftInputKind === 'receipt'
                      ? 'Read from the receipt photo'
                      : 'Drafted from your description'}
                  </span>
                </div>
                <Badge variant={draft.verification === 'text' ? 'navy' : 'warning'} size="sm">
                  {draft.verification === 'text' ? 'Checked against your text' : 'Check against the photo'}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="min-w-0 break-words rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Amount</span>
                  <div className="font-bold text-navy">
                    {draft.amount !== null ? formatPeso(draft.amount) : 'Not determined — left blank'}
                  </div>
                </div>
                <div className="min-w-0 break-words rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Category</span>
                  <div className="font-bold text-navy">
                    {draft.category
                      ? `${EXPENSE_CATEGORY_LABELS[draft.category]}${
                          draft.categorySource === 'vendor_memory'
                            ? ' (from your supplier history)'
                            : draft.categorySource === 'llm'
                              ? ' (AI suggestion)'
                              : ' (built-in rule)'
                        }`
                      : 'Not determined'}
                  </div>
                </div>
                <div className="min-w-0 break-words rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Project</span>
                  <div className="font-bold text-navy">
                    {draft.projectLabel || 'Not matched — choose the project'}
                  </div>
                </div>
                <div className="min-w-0 break-words rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Supplier</span>
                  <div className="font-bold text-navy">{draft.vendor || 'Not named'}</div>
                </div>
              </div>

              {draftInputKind === 'text' && draft.evidence.find((line) => line.startsWith('Calculated from ')) && (
                <p className="rounded-xl border border-slate-200 bg-white p-2.5 text-xs text-ink-secondary">
                  {draft.evidence.find((line) => line.startsWith('Calculated from '))}
                </p>
              )}

              {draft.evidence.length > 0 && (
                <details className="rounded-xl border border-slate-200 bg-white p-2.5 text-xs">
                  <summary className="cursor-pointer font-semibold text-navy">
                    Why these values? (evidence)
                  </summary>
                  <ul className="mt-2 space-y-1 text-ink-secondary">
                    {draft.evidence.map((line, index) => (
                      <li key={index}>• {line}</li>
                    ))}
                  </ul>
                </details>
              )}

              {draft.unresolved.length > 0 && (
                <div className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-xs text-status-warning">
                  <div className="font-semibold">Needs your input</div>
                  <ul className="mt-1 space-y-1">
                    {draft.unresolved.map((line, index) => (
                      <li key={index}>• {line}</li>
                    ))}
                  </ul>
                </div>
              )}

              {draft.degradedReason && (
                <p className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-xs text-status-warning">
                  {draft.degradedReason}
                </p>
              )}

              {contextWarnings.map((warning) => (
                <p key={warning} className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-xs text-status-warning">
                  {warning}
                </p>
              ))}

              {draftExtractedText && (
                <details className="rounded-xl border border-slate-200 bg-white p-2.5 text-xs">
                  <summary className="cursor-pointer font-semibold text-navy">
                    Text read from the receipt (not part of the recorded expense)
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-ink-secondary">
                    {draftExtractedText}
                  </pre>
                </details>
              )}

              {pendingReceiptPreview && (
                <div className="rounded-xl border border-slate-200 bg-white p-2.5">
                  <div className="text-xs font-semibold text-navy">
                    Check every field against this photo
                  </div>
                  <img
                    src={pendingReceiptPreview}
                    alt="Receipt photo awaiting your review"
                    className="mt-2 max-h-72 w-full rounded-lg object-contain lg:max-h-96"
                  />
                  <button type="button" onClick={() => void openDraftPhoto()} className="mt-2 inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-navy underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">Open photo full size</button>
                  <p className="mt-1 text-xs text-ink-muted">
                    {formData.receipt_url ? 'The photo has been uploaded to private storage.' : 'This photo is uploaded to private storage when you save a draft or record the expense.'}
                  </p>
                  <button type="button" onClick={handleRemoveReceipt} className="mt-1 min-h-11 rounded-lg px-2 text-xs font-semibold text-status-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    Remove receipt photo
                  </button>
                </div>
              )}

              {draftWarnings && (
                <div className="space-y-1 text-xs">
                  <p className="text-ink-muted">Checks below are based on the initial draft and may not reflect later edits.</p>
                  {draftWarnings.duplicates.length > 0 && (
                    <p className="rounded-xl border border-status-danger/20 bg-status-danger-bg p-2.5 text-status-danger">
                      Possible duplicate: {draftWarnings.duplicates[0].reason} Check before saving —
                      the earlier entry is “{draftWarnings.duplicates[0].expense.description.slice(0, 40)}”.
                    </p>
                  )}
                  {draftWarnings.outlier?.isOutlier && (
                    <p className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-status-warning">
                      {draftWarnings.outlier.message}
                    </p>
                  )}
                  {draftWarnings.outlier && !draftWarnings.outlier.isOutlier && draftWarnings.outlier.ratio !== null && (
                    <p className="rounded-xl border border-slate-200 bg-white p-2.5 text-ink-secondary">
                      {draftWarnings.outlier.message}
                    </p>
                  )}
                  {draftWarnings.missingReceipt && !pendingReceiptFile && !formData.receipt_url && (
                    <p className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-status-warning">
                      {draftWarnings.missingReceipt.reason} Attach the photo, or save and attach it later.
                    </p>
                  )}
                </div>
              )}

              <p className="flex items-start gap-1.5 text-xs text-ink-muted">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  AI output is assistive and unreviewed until you save. Editing any field beside or below is
                  expected — the ledger records what you confirm, not what the model suggested.
                </span>
              </p>
            </div>
          )}

          <div className="min-w-0 space-y-4">
          <Select
            label="Associated Project Site"
            value={formData.project_id}
            onChange={(e) => setFormData({ ...formData, project_id: e.target.value })}
            required
          >
            <option value="">Select Project Site...</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label htmlFor="expense-description" className="text-xs font-semibold text-ink-secondary">
                Expense title
              </label>
              <button
                type="button"
                onClick={handleAnalyzeWithAI}
                disabled={!formData.description || isAnalyzing}
                className="inline-flex min-h-11 items-center space-x-1 text-xs font-bold text-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Sparkles className="w-3 h-3 text-navy" />
                <span>{isAnalyzing ? 'Analyzing with AI...' : 'Analyze with Groq AI'}</span>
              </button>
            </div>
            <Input
              id="expense-description"
              placeholder="e.g. Cement and construction materials"
              hint={draftInputKind === 'receipt' ? 'Review this short title against the receipt.' : undefined}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              required
            />
          </div>

          <Textarea label="Description (optional)" placeholder="Add more details about this purchase" maxLength={5000} rows={2} value={formData.details} onChange={e => setFormData({ ...formData, details:e.target.value })} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Amount (PHP ₱)"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="5000"
              value={formData.amount}
              onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
              required
            />

            <Input
              label="Expense Date"
              type="date"
              value={formData.expense_date}
              onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })}
              required
            />
          </div>

          {draftInputKind === 'receipt' && itemRows.length > 0 && <p className="text-xs text-status-warning">These items are suggestions from the photo. Check and correct each one before saving.</p>}
          <ExpenseItemsEditor rows={itemRows} onChange={setItemRows} receiptTotal={formData.amount} />

          {/* GROQ AI SUGGESTION BOX */}
          {aiResult && (
            <div className="p-4 rounded-2xl bg-gradient-to-br from-slate-50 to-sky-50/40 border border-status-info/20 space-y-3 animate-in fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-navy font-bold text-xs">
                  <Bot className="w-4 h-4 text-navy" />
                  <span>
                    {aiResult.source === 'llm'
                      ? 'Groq AI Ledger Suggestion'
                      : 'Built-in Rule Suggestion'}
                  </span>
                </div>
                <Badge variant={aiResult.source === 'llm' ? 'navy' : 'neutral'} size="sm">
                  {aiResult.source === 'llm' ? 'AI' : 'Rules'}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 rounded-xl bg-white border border-slate-200">
                  <span className="text-ink-secondary">Suggested Category:</span>
                  <div className="font-semibold text-navy">{aiResult.category}</div>
                </div>
                <div className="p-2 rounded-xl bg-white border border-slate-200">
                  <span className="text-ink-secondary">Possible Worker Bale:</span>
                  <div className={`font-bold ${aiResult.isBale ? 'text-status-warning' : 'text-status-success'}`}>
                    {aiResult.isBale ? 'YES (Advance Detected)' : 'No (Standard Expense)'}
                  </div>
                </div>
              </div>

              {/* Evidence replaces the old invented "% confidence" figure. */}
              <div className="text-xs text-ink-secondary bg-white p-2.5 rounded-xl border border-slate-200 space-y-1">
                <div>
                  <span className="font-semibold text-navy">Why: </span>
                  {aiResult.reasoning}
                </div>
                {aiResult.evidence.length > 0 ? (
                  <div className="text-ink-muted">Based on {aiResult.evidence.join(', ')}</div>
                ) : (
                  <div className="text-ink-muted">
                    Nothing matched — please choose the category manually.
                  </div>
                )}
                {aiResult.degradedReason && (
                  <div className="text-status-warning font-medium">{aiResult.degradedReason}</div>
                )}
              </div>

              {/* Founder Confirmation Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="text-xs text-ink-muted italic">
                  * AI suggestions require Founder confirmation before recording
                </span>

                {!aiAccepted ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={handleAcceptAISuggestion}
                    leftIcon={<Check className="w-3.5 h-3.5" />}
                  >
                    Accept AI Suggestions
                  </Button>
                ) : (
                  <span className="text-status-success font-bold text-xs flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4 text-status-success" />
                    Suggestions Applied
                  </span>
                )}
              </div>
            </div>
          )}

          <Input
            label="Supplier / Shop (used for duplicate checks and your supplier history)"
            placeholder="e.g. JMC Hardware"
            value={formData.vendor}
            onChange={(event) => setFormData({ ...formData, vendor: event.target.value })}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Expense Category"
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value as ExpenseCategory | '' })}
              required
            >
              <option value="">Select a category...</option>
              <option value="materials">Materials</option>
              <option value="labor">Labor</option>
              <option value="equipment">Equipment</option>
              <option value="permits">Permits</option>
              <option value="transportation">Transportation</option>
              <option value="other">Other</option>
            </Select>

            <div>
              <span className="text-xs font-semibold text-ink-secondary block mb-1.5">
                Receipt / Invoice Photo
              </span>
              <label className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-surface-inset border border-surface-border hover:bg-slate-200 cursor-pointer text-xs font-semibold text-navy transition-colors focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2">
                {isUploadingReceipt ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Uploading to Supabase…</span>
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    <span>{formData.receipt_url ? 'Replace Receipt' : 'Attach Photo'}</span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={handleReceiptUpload}
                  disabled={isUploadingReceipt}
                />
              </label>
              {formData.receipt_url && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-status-success/20 bg-status-success-bg px-3 py-2">
                  <div className="min-w-0 flex items-center gap-2 text-status-success">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span className="truncate text-xs font-semibold">
                      Receipt Attached ✓{receiptFileName ? ` — ${receiptFileName}` : ''}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <button type="button" onClick={() => void openReceiptPreview(formData.receipt_url!)} className="min-h-11 text-xs font-bold text-navy hover:underline">View</button>
                    <button type="button" onClick={handleRemoveReceipt} className="min-h-11 text-xs font-bold text-status-danger hover:underline">Remove</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <Textarea
            label="Site Notes / Official Receipt Number"
            placeholder="Official Receipt # / Supplier Delivery Slip info"
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            rows={2}
          />

          <div className="flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={requestCloseEntry} disabled={isSubmitting || isUploadingReceipt || isSavingDraft}>
              Cancel
            </Button>
            <Button type="button" variant="secondary" onClick={() => void handleSaveDraft(false)} isLoading={isSavingDraft} disabled={draftLoadState !== 'ready' || isSubmitting || isUploadingReceipt}>Save draft</Button>
            <Button variant="primary" type="submit" isLoading={isSubmitting} disabled={isUploadingReceipt || isSavingDraft}>
              {isSubmitting ? 'Saving expense…' : isUploadingReceipt ? 'Uploading receipt…' : 'Confirm & Save Expense'}
            </Button>
          </div>
          </div>
        </div></fieldset></form>
      </Modal>

      <ReceiptPhotoViewer isOpen={isPhotoViewerOpen && Boolean(pendingReceiptPreview)} src={pendingReceiptPreview} onClose={() => setPhotoViewerOpen(false)} />

      <Modal isOpen={showCloseDraft} onClose={() => setShowCloseDraft(false)} title="Unfinished expense" description="Save the draft to continue later, keep editing, or discard these unsaved changes." maxWidth="sm" role="alertdialog" dismissOnBackdrop={false} dismissOnEscape={!isSavingDraft} showCloseButton={!isSavingDraft}>
        <div className="flex flex-col gap-2"><Button type="button" variant="primary" isLoading={isSavingDraft} disabled={draftLoadState !== 'ready'} onClick={() => void handleSaveDraft(true)}>Save draft</Button><Button type="button" variant="secondary" disabled={isSavingDraft} onClick={() => setShowCloseDraft(false)}>Keep editing</Button><Button type="button" variant="ghost" disabled={isSavingDraft} onClick={() => { resetEntry(); setShowCloseDraft(false); setIsAddModalOpen(false); }}>Discard unsaved changes</Button></div>
      </Modal>
      <ConfirmDialog isOpen={showDiscardDraft} title="Discard saved draft?" message="The saved draft will be removed. No recorded expense will be changed. An uploaded photo may remain in private storage." confirmLabel="Discard draft" cancelLabel="Keep draft" destructive isPending={isSavingDraft} onCancel={() => setShowDiscardDraft(false)} onConfirm={() => void discardSavedDraft()} />

      <ConfirmDialog isOpen={confirmNewTextDraft} title="Replace unfinished expense?" message="A successful new draft replaces the current entry. If drafting fails, the entry stays. Your saved draft remains until you replace or discard it." confirmLabel="Create new draft" cancelLabel="Keep my entry" onCancel={() => setConfirmNewTextDraft(false)} onConfirm={() => { setConfirmNewTextDraft(false); void handleDraftFromText(true); }} />
      <ConfirmDialog
        isOpen={Boolean(receiptToConfirm)}
        title="Replace unfinished expense?"
        message="A successful scan replaces the unfinished expense details and selected receipt. If scanning fails, your entry stays as it is."
        confirmLabel="Scan new receipt"
        cancelLabel="Keep my entry"
        onCancel={() => setReceiptToConfirm(null)}
        onConfirm={() => {
          const file = receiptToConfirm;
          setReceiptToConfirm(null);
          if (file) void handleDraftFromReceipt(file);
        }}
      />

      <ExpenseDetailsModal expense={selectedExpense} projects={projects} onClose={() => setSelectedExpense(null)} onUpdate={updateExpense} onReceipt={path => { void openReceiptPreview(path); }} />

      <ReceiptPhotoViewer isOpen={Boolean(selectedReceiptUrl)} src={selectedReceiptUrl} onClose={() => setSelectedReceiptUrl(null)} />

      {/* BALE RECIPIENT CONFIRMATION — nothing is deducted without an explicit choice */}
      <Modal
        isOpen={Boolean(balePrompt)}
        onClose={handleDismissBalePrompt}
        title="Worker advance detected"
        description="This expense looks like a cash advance (bale). Choose who received it — nothing is deducted automatically."
        maxWidth="md"
      >
        {balePrompt && (
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-semibold text-navy">{balePrompt.description}</div>
              <div className="text-ink-secondary">
                {formatPeso(balePrompt.amount)} · {balePrompt.expenseDate}
              </div>
            </div>

            <Select
              label="Advance recipient"
              value={baleWorkerId}
              onChange={(event) => setBaleWorkerId(event.target.value)}
              hint="The advance is deducted from this worker's next payroll cycle."
            >
              <option value="">Select the worker who received this advance…</option>
              {workers
                .filter((worker) => worker.active)
                .map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name} — {worker.position}
                  </option>
                ))}
            </Select>

            {mentionedWorkers.length > 0 && (
              <p className="text-[11px] text-ink-secondary">
                Mentioned in the description (not selected automatically):{' '}
                <span className="font-semibold text-navy">
                  {mentionedWorkers.map((worker) => worker.name).join(', ')}
                </span>
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDismissBalePrompt}
                disabled={isCreatingAdvance}
              >
                Not a worker advance
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleConfirmBaleAdvance}
                disabled={!baleWorkerId}
                isLoading={isCreatingAdvance}
              >
                Record advance in Bale ledger
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
