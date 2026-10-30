import { describe, expect, it, vi } from 'vitest';
import { resolveReceiptForSubmission } from '@/lib/expenses/receiptSubmission';

describe('receipt handling before expense submission', () => {
  it('allows an intentionally receipt-free entry', async () => {
    const upload = vi.fn();
    expect(await resolveReceiptForSubmission(null, null, upload)).toEqual({ ok: true, path: null });
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads a pending receipt and reuses an existing path on retry', async () => {
    const upload = vi.fn().mockResolvedValue('receipts/photo.jpg');
    expect(await resolveReceiptForSubmission(null, 'photo', upload)).toEqual({ ok: true, path: 'receipts/photo.jpg' });
    expect(await resolveReceiptForSubmission('receipts/photo.jpg', 'photo', upload)).toEqual({ ok: true, path: 'receipts/photo.jpg' });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('does not permit an expense write if a selected receipt fails to upload', async () => {
    expect(await resolveReceiptForSubmission(null, 'photo', async () => null)).toEqual({ ok: false });
    expect(await resolveReceiptForSubmission(null, 'photo', async () => { throw new Error('network'); })).toEqual({ ok: false });
  });
});
