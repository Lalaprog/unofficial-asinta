'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { useToast } from '@/components/ui/Toast';
import { createClient } from '@/lib/supabase/client';
import { ExpenseCategory } from '@/types';
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
  Mic,
  Square,
  AlertTriangle,
  FileText,
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

export default function ExpensesPage() {
  const { user } = useAuth();
  const {
    expenses,
    projects,
    createExpense,
    createAdvance,
    workers,
  } = useDataStore();
  const { showToast } = useToast();
  const supabase = createClient();

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');

  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedReceiptUrl, setSelectedReceiptUrl] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    project_id: '',
    description: '',
    amount: '',
    category: 'materials' as ExpenseCategory,
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
   * A receipt photo captured for the AI read but not yet stored. It is uploaded
   * only when the Founder saves the expense, so an abandoned draft leaves no
   * orphan object in the bucket.
   */
  const [pendingReceiptFile, setPendingReceiptFile] = useState<File | null>(null);
  const [pendingReceiptPreview, setPendingReceiptPreview] = useState<string | null>(null);

  // Track E / B / D: one messy line, a receipt photo, or a spoken note.
  const [quickText, setQuickText] = useState('');
  const [isDrafting, setIsDrafting] = useState(false);
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [draftWarnings, setDraftWarnings] = useState<ExpenseWarningSummary | null>(null);
  const [draftInputKind, setDraftInputKind] = useState<'text' | 'receipt' | 'voice' | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftTranscript, setDraftTranscript] = useState<string | null>(null);
  const [draftExtractedText, setDraftExtractedText] = useState<string | null>(null);
  const [contextWarnings, setContextWarnings] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const expenseSubmitLock = React.useRef(false);

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
      (exp.vendor && exp.vendor.toLowerCase().includes(searchQuery.toLowerCase()));

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
    if (expenseSubmitLock.current || isUploadingReceipt || !formData.project_id || !formData.description || !formData.amount) return;
    if (!user) {
      showToast('error', 'You must be signed in to record expenses.');
      return;
    }

    expenseSubmitLock.current = true;
    setIsSubmitting(true);
    try {
      const amountNum = parseFloat(formData.amount);

      // A receipt captured for the AI read is uploaded now, not earlier: an
      // abandoned draft must not leave an orphan object in the bucket.
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
      });

      if (newExp) {
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
          amount: '',
          category: 'materials',
          expense_date: new Date().toISOString().split('T')[0],
          notes: '',
          receipt_url: null,
          vendor: '',
        });
        setAiResult(null);
        setAiAccepted(false);
        setReceiptFileName(null);
        setDraft(null);
        setDraftWarnings(null);
        setDraftInputKind(null);
        setDraftModel(null);
        setDraftTranscript(null);
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
  // Track E / B / D — draft from a line of text, a receipt photo, or a voice note
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
    input: { kind: 'text' | 'receipt' | 'voice'; model?: string | null; transcript?: string | null; extractedText?: string | null }
  ) => {
    setFormData((previous) => ({
      ...previous,
      description: nextDraft.description || previous.description,
      amount: nextDraft.amount !== null ? String(nextDraft.amount) : previous.amount,
      expense_date: nextDraft.expenseDate ?? previous.expense_date,
      project_id: nextDraft.projectId ?? previous.project_id,
      category: nextDraft.category ?? previous.category,
      vendor: nextDraft.vendor ?? previous.vendor,
      notes: nextDraft.noteEvidence
        ? previous.notes
          ? `${previous.notes} ${nextDraft.noteEvidence}`
          : nextDraft.noteEvidence
        : previous.notes,
    }));

    // The draft's category is a suggestion with provenance, so it feeds the
    // same review box the manual "Analyze with Groq AI" button uses.
    if (nextDraft.category) {
      setAiResult({
        category: nextDraft.category,
        isBale: nextDraft.isBaleHint,
        reasoning:
          nextDraft.categorySource === 'vendor_memory'
            ? 'Suggested from your own history with this supplier.'
            : nextDraft.categorySource === 'llm'
              ? `Extracted from the ${input.kind === 'text' ? 'description' : input.kind === 'receipt' ? 'receipt photo' : 'voice note'} by the AI model.`
              : 'Suggested by the built-in rules.',
        evidence: nextDraft.evidence.slice(0, 3),
        source: nextDraft.categorySource === 'llm' ? 'llm' : 'rules',
      });
      setAiAccepted(false);
    }

    setDraft(nextDraft);
    setDraftInputKind(input.kind);
    setDraftModel(input.model ?? null);
    setDraftTranscript(input.transcript ?? null);
    setDraftExtractedText(input.extractedText ?? null);
    setIsAddModalOpen(true);

    const amount = nextDraft.amount !== null ? formatPeso(nextDraft.amount) : null;
    showToast(
      'info',
      amount
        ? `Draft ready — ${amount}${nextDraft.vendor ? ` at ${nextDraft.vendor}` : ''}. Review every field, then save.`
        : 'Draft ready. The amount was not stated, so it was left blank — enter it yourself.'
    );
  };

  const handleDraftFromText = async () => {
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
        resolve({ mediaType: match[1], base64: match[2] });
      };
      reader.readAsDataURL(file);
    });

  const handleDraftFromReceipt = async (file: File) => {
    if (isDrafting) return;
    setIsDrafting(true);
    setDraftWarnings(null);
    setContextWarnings([]);
    setPendingReceiptFile(file);
    // Local preview only — the photo is uploaded when the expense is saved.
    setPendingReceiptPreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });

    try {
      const { mediaType, base64 } = await readReceiptFileAsBase64(file);
      const response = await fetch('/api/ai/receipt-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaType, base64 }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        // Honest failure: the manual path is untouched and we say so.
        showToast(
          'error',
          payload?.error ||
            'The receipt could not be read by the AI model. Type the expense instead — nothing is blocked.'
        );
        return;
      }

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

  const startRecording = async () => {
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
    } catch (caught) {
      showToast(
        'error',
        caught instanceof Error
          ? `Microphone unavailable: ${caught.message}. Type the expense instead.`
          : 'Microphone unavailable. Type the expense instead.'
      );
    }
  };

  // Auto-stop: a bounded recording keeps the transcription request (and its
  // cost) bounded, and a forgotten tab cannot record indefinitely.
  React.useEffect(() => {
    if (!isRecording) return;
    const interval = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(interval);
  }, [isRecording]);

  const stopRecording = () => {
    recorderRef.current?.stop();
    setIsRecording(false);
  };

  const handleDraftFromVoice = async () => {
    const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
    if (blob.size === 0) {
      showToast('error', 'Nothing was recorded — hold the button, speak, then stop.');
      return;
    }
    if (blob.size > 20 * 1024 * 1024) {
      showToast('error', 'That recording is too large. Record a shorter note.');
      return;
    }

    setIsDrafting(true);
    setContextWarnings([]);
    try {
      const form = new FormData();
      form.append('audio', blob, 'site-note.webm');
      const response = await fetch('/api/ai/voice-draft', { method: 'POST', body: form });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        showToast(
          'error',
          payload?.error || 'The recording could not be transcribed. Type the expense instead.'
        );
        return;
      }

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
        kind: 'voice',
        model: payload.transcriptionModel ?? null,
        transcript: payload.transcript ?? null,
      });
    } catch (caught) {
      showToast(
        'error',
        caught instanceof Error ? `Transcription failed: ${caught.message}` : 'Transcription failed.'
      );
    } finally {
      setIsDrafting(false);
      recordedChunksRef.current = [];
    }
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
            <Button variant="primary" size="md" onClick={() => setIsAddModalOpen(true)} leftIcon={<Plus className="w-4 h-4" />}>
              Record Expense
            </Button>
          }
        />

        {/* ------------------------------------------------------------------
            TRACK E / B / D — one messy line, a receipt photo, or a voice note.
            The model extracts; the Founder confirms in the modal below. Nothing
            written here reaches the ledger.
           ------------------------------------------------------------------ */}
        <div className="rounded-xl border border-surface-border bg-white p-4 sm:p-5 space-y-3">
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
                  : draftInputKind === 'voice'
                    ? 'Transcribed from a voice note'
                    : 'Drafted from your description'}
                {draftModel ? ` · ${draftModel}` : ''}
              </span>
            )}
          </div>

          <Textarea
            label="Describe the expense"
            placeholder={'e.g. 12 bags cement at JMC Hardware for Casa Batangas, 4800, kahapon, receipt na kay Danilo'}
            value={quickText}
            onChange={(event) => setQuickText(event.target.value)}
            rows={2}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleDraftFromText}
              isLoading={isDrafting && draftInputKind !== 'receipt' && draftInputKind !== 'voice'}
              disabled={!quickText.trim() || isDrafting}
              leftIcon={<Sparkles className="h-3.5 w-3.5" />}
            >
              Draft expense
            </Button>

            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-surface-border bg-surface-inset px-3 py-2 text-[11px] font-semibold text-navy transition-all hover:bg-slate-200 focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2">
              <ScanLine className="h-3.5 w-3.5" />
              <span>{isDrafting ? 'Reading…' : 'Scan a receipt photo'}</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={isDrafting}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void handleDraftFromReceipt(file);
                }}
              />
            </label>

            {isRecording ? (
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-2 rounded-xl border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-[11px] font-semibold text-status-danger"
              >
                <Square className="h-3.5 w-3.5" />
                Stop recording ({recordingSeconds}s)
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                disabled={isDrafting}
                className="inline-flex items-center gap-2 rounded-xl border border-surface-border bg-surface-inset px-3 py-2 text-[11px] font-semibold text-navy transition-all hover:bg-slate-200 disabled:opacity-50"
              >
                <Mic className="h-3.5 w-3.5" />
                Record a voice note
              </button>
            )}

            {recordingSeconds > 0 && !isRecording && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDraftFromVoice}
                isLoading={isDrafting}
                disabled={isDrafting}
                leftIcon={<FileText className="h-3.5 w-3.5" />}
              >
                Transcribe &amp; draft ({recordingSeconds}s)
              </Button>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-ink-muted">
            The AI reads and the rules validate: an amount that is not written in your text stays
            blank, a project must match a real project record, and a supplier that is not named is
            not recorded. Voice notes over ~20 MB and receipt photos over 4 MB are refused with a
            reason instead of failing silently.
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
        <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
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
                      onClick={() => setIsAddModalOpen(true)}
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
        onClose={() => setIsAddModalOpen(false)}
        dismissOnBackdrop={!isSubmitting && !isUploadingReceipt}
        dismissOnEscape={!isSubmitting && !isUploadingReceipt}
        showCloseButton={!isSubmitting && !isUploadingReceipt}
        title="Record Site Expense"
        description="Enter the details. Suggestions may come from the Groq model or the built-in rules — you confirm every field."
        maxWidth="lg"
      >
        <form onSubmit={handleAddSubmit} className="space-y-4 text-xs">
          {/* DRAFT REVIEW — what the AI read, what the rules verified, and what
              is still missing. The Founder confirms; nothing is saved yet. */}
          {draft && (
            <div className="space-y-3 rounded-2xl border border-status-info/20 bg-status-info-bg/50 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 text-navy font-bold">
                  <Bot className="h-4 w-4" />
                  <span>
                    {draftInputKind === 'receipt'
                      ? 'Read from the receipt photo'
                      : draftInputKind === 'voice'
                        ? 'Transcribed from your voice note'
                        : 'Drafted from your description'}
                  </span>
                </div>
                <Badge variant={draft.verification === 'text' ? 'navy' : 'warning'} size="sm">
                  {draft.verification === 'text' ? 'Checked against your text' : 'Check against the photo / recording'}
                </Badge>
              </div>

              <div className="grid gap-2 text-[11px] sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Amount</span>
                  <div className="font-bold text-navy">
                    {draft.amount !== null ? formatPeso(draft.amount) : 'Not stated — left blank'}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-2">
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
                <div className="rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Project</span>
                  <div className="font-bold text-navy">
                    {draft.projectLabel || 'Not matched — choose the project'}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-2">
                  <span className="text-ink-secondary">Supplier</span>
                  <div className="font-bold text-navy">{draft.vendor || 'Not named'}</div>
                </div>
              </div>

              {draft.evidence.length > 0 && (
                <details className="rounded-xl border border-slate-200 bg-white p-2.5 text-[11px]">
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
                <div className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-[11px] text-status-warning">
                  <div className="font-semibold">Needs your input</div>
                  <ul className="mt-1 space-y-1">
                    {draft.unresolved.map((line, index) => (
                      <li key={index}>• {line}</li>
                    ))}
                  </ul>
                </div>
              )}

              {draft.degradedReason && (
                <p className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-[11px] text-status-warning">
                  {draft.degradedReason}
                </p>
              )}

              {contextWarnings.map((warning) => (
                <p key={warning} className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-[11px] text-status-warning">
                  {warning}
                </p>
              ))}

              {draftTranscript && (
                <div className="rounded-xl border border-slate-200 bg-white p-2.5 text-[11px]">
                  <div className="font-semibold text-navy">Transcript (check it against what you said)</div>
                  <p className="mt-1 text-ink-secondary">“{draftTranscript}”</p>
                </div>
              )}

              {draftExtractedText && (
                <details className="rounded-xl border border-slate-200 bg-white p-2.5 text-[11px]">
                  <summary className="cursor-pointer font-semibold text-navy">
                    Text read from the receipt
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-ink-secondary">
                    {draftExtractedText}
                  </pre>
                </details>
              )}

              {pendingReceiptPreview && (
                <div className="rounded-xl border border-slate-200 bg-white p-2.5">
                  <div className="text-[11px] font-semibold text-navy">
                    Check every field against this photo
                  </div>
                  <img
                    src={pendingReceiptPreview}
                    alt="Receipt photo awaiting your review"
                    className="mt-2 max-h-56 w-full rounded-lg object-contain"
                  />
                  <p className="mt-1 text-[10px] text-ink-muted">
                    {formData.receipt_url ? 'The photo has been uploaded to private storage.' : 'This photo is uploaded to private storage only when you save the expense.'}
                  </p>
                  <button type="button" onClick={handleRemoveReceipt} className="mt-1 min-h-11 rounded-lg px-2 text-xs font-semibold text-status-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    Remove receipt photo
                  </button>
                </div>
              )}

              {draftWarnings && (
                <div className="space-y-1 text-[11px]">
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
                  {draftWarnings.missingReceipt && (
                    <p className="rounded-xl border border-status-warning/20 bg-status-warning-bg p-2.5 text-status-warning">
                      {draftWarnings.missingReceipt.reason} Attach the photo, or save and attach it later.
                    </p>
                  )}
                </div>
              )}

              <p className="flex items-start gap-1.5 text-[10px] text-ink-muted">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  AI output is assistive and unreviewed until you save. Editing any field below is
                  expected — the ledger records what you confirm, not what the model suggested.
                </span>
              </p>
            </div>
          )}

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
                Expense Description
              </label>
              <button
                type="button"
                onClick={handleAnalyzeWithAI}
                disabled={!formData.description || isAnalyzing}
                className="text-[11px] text-navy font-bold hover:underline inline-flex items-center space-x-1"
              >
                <Sparkles className="w-3 h-3 text-navy" />
                <span>{isAnalyzing ? 'Analyzing with AI...' : 'Analyze with Groq AI'}</span>
              </button>
            </div>
            <Input
              id="expense-description"
              placeholder="e.g. Advance cash ₱3,000 for Danilo Magpantay emergency medical"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              onBlur={handleAnalyzeWithAI}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
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

              <div className="grid grid-cols-2 gap-2 text-[11px]">
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
              <div className="text-[11px] text-ink-secondary bg-white p-2.5 rounded-xl border border-slate-200 space-y-1">
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
              <div className="pt-1 flex items-center justify-between">
                <span className="text-[10px] text-ink-muted italic">
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

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Expense Category"
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value as ExpenseCategory })}
            >
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
                    <span className="truncate text-[11px] font-semibold">
                      Receipt Attached ✓{receiptFileName ? ` — ${receiptFileName}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveReceipt}
                    className="shrink-0 text-[11px] font-bold text-status-danger hover:underline"
                  >
                    Remove
                  </button>
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

          <div className="pt-4 flex justify-end space-x-2">
            <Button type="button" variant="secondary" onClick={() => setIsAddModalOpen(false)} disabled={isSubmitting || isUploadingReceipt}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" isLoading={isSubmitting} disabled={isUploadingReceipt}>
              {isSubmitting ? 'Saving expense…' : isUploadingReceipt ? 'Uploading receipt…' : 'Confirm & Save Expense'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* RECEIPT PREVIEW MODAL — private bucket, so the src is a short-lived signature */}
      <Modal
        isOpen={Boolean(selectedReceiptUrl)}
        onClose={() => setSelectedReceiptUrl(null)}
        title="Official Receipt Photo"
        description="Captured proof of purchase & supplier receipt. Loaded through a signed URL that expires in 5 minutes."
      >
        {selectedReceiptUrl && (
          <div className="space-y-4">
            <div className="rounded-2xl overflow-hidden border border-surface-border bg-slate-100 flex items-center justify-center max-h-[70vh]">
              <img
                src={selectedReceiptUrl}
                alt="Receipt Voucher"
                className="w-full h-auto object-contain max-h-[60vh]"
              />
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={() => setSelectedReceiptUrl(null)}>
                Close Preview
              </Button>
            </div>
          </div>
        )}
      </Modal>

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
