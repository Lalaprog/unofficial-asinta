import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  RECEIPT_ALLOWED_MIME_TYPES,
  RECEIPT_MAX_BYTES,
  buildReceiptObjectPath,
  canonicalReceiptMime,
  canonicalReceiptUpload,
  createReceiptSignedUrl,
  receiptPathFromStoredValue,
  validateReceiptFile,
} from '@/lib/supabase/receipts';

/**
 * Receipt storage: the bucket is private, `expenses.receipt_url` holds a PATH,
 * and the extension comes from the MIME allowlist. These tests pin those three
 * properties — the first is the security fix from this pass, and the third
 * closes the "extension taken from the filename" finding.
 */

describe('receipt file validation', () => {
  it('accepts the allowlisted image types and returns the stored extension', () => {
    expect(validateReceiptFile({ type: 'image/jpeg', size: 1024 })).toEqual({ ok: true, extension: 'jpg' });
    expect(validateReceiptFile({ type: 'image/png', size: 1024 })).toEqual({ ok: true, extension: 'png' });
    expect(validateReceiptFile({ type: 'image/webp', size: 1024 })).toEqual({ ok: true, extension: 'webp' });
    expect(canonicalReceiptMime('image/jpg')).toBe('image/jpeg');
    expect(canonicalReceiptMime('IMAGE/JPEG')).toBe('image/jpeg');
    expect(canonicalReceiptMime('image/gif')).toBeNull();
    const file = new File(['abc'], 'sample.jpg', {type:'image/jpg', lastModified:123});
    const canonical = canonicalReceiptUpload(file);
    expect(canonical.type).toBe('image/jpeg'); expect(canonical.size).toBe(3); expect(canonical.lastModified).toBe(123);
    expect(canonicalReceiptUpload(canonical)).toBe(canonical);
    expect(() => canonicalReceiptUpload(new File(['abc'], 'sample.gif', {type:'image/gif'}))).toThrow(/Unsupported/);
  });

  it('rejects anything outside the allowlist', () => {
    expect(validateReceiptFile({ type: 'image/gif', size: 10 }).ok).toBe(false);
    expect(validateReceiptFile({ type: 'application/pdf', size: 10 }).ok).toBe(false);
    expect(validateReceiptFile({ type: 'image/svg+xml', size: 10 }).ok).toBe(false);
    expect(validateReceiptFile({ type: 'constructor', size: 10 }).ok).toBe(false);
    // Only the three bucket-allowed types (plus the jpg alias) may appear.
    expect([...RECEIPT_ALLOWED_MIME_TYPES].sort()).toEqual([
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
    ]);
  });

  it('rejects empty and oversized files with a usable message', () => {
    expect(validateReceiptFile({ type: 'image/jpeg', size: 0 }).ok).toBe(false);
    for (const size of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) expect(validateReceiptFile({ type: 'image/jpeg', size }).ok).toBe(false);
    expect(validateReceiptFile({ type: 'image/jpeg', size: RECEIPT_MAX_BYTES }).ok).toBe(true);
    const big = validateReceiptFile({ type: 'image/jpeg', size: RECEIPT_MAX_BYTES + 1 });
    expect(big.ok).toBe(false);
    expect(big.error).toMatch(/5 MB/);
  });
});

describe('receipt Storage SDK multipart behavior', () => {
  it('sends the canonical MIME in the actual multipart File part', async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({Key:'receipts/path.jpg',Id:'test'}), {status:200,headers:{'content-type':'application/json'}}));
    const client = createClient('https://fixture.supabase.co','non-secret-fixture-key',{global:{fetch:transport}});
    const file=canonicalReceiptUpload(new File(['abc'],'receipt.jpg',{type:'image/jpg'}));
    const result=await client.storage.from('receipts').upload('path.jpg',file,{contentType:'image/jpeg'});
    expect(result.error).toBeNull();
    const init=transport.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    const part=(init.body as FormData).get('') as File;
    expect(part.type).toBe('image/jpeg');expect(await part.text()).toBe('abc');
  });
});

describe('object paths', () => {
  it('builds a path under the uploader id with a random suffix', () => {
    const path = buildReceiptObjectPath('user-abc', 'jpg', { now: 1700000000000, random: 'zz9' });
    expect(path).toBe('user-abc/1700000000000-zz9.jpg');
  });

  it('strips characters that could break out of the path', () => {
    const path = buildReceiptObjectPath('../evil', 'jpg', { now: 1, random: 'x' });
    expect(path.startsWith('..')).toBe(false);
    expect(path).not.toMatch(/\.\./);
  });
});

describe('stored value → storage path', () => {
  it('passes a bare path through', () => {
    expect(receiptPathFromStoredValue('user-1/123-ab.jpg')).toBe('user-1/123-ab.jpg');
  });

  it('converts a legacy public URL (the pre-migration format)', () => {
    expect(
      receiptPathFromStoredValue(
        'https://xyz.supabase.co/storage/v1/object/public/receipts/user-1/123-ab.jpg'
      )
    ).toBe('user-1/123-ab.jpg');
  });

  it('strips the token from a legacy signed URL', () => {
    expect(
      receiptPathFromStoredValue(
        'https://xyz.supabase.co/storage/v1/object/sign/receipts/user-1/123-ab.jpg?token=abc.def'
      )
    ).toBe('user-1/123-ab.jpg');
  });

  it('refuses traversal and foreign URLs', () => {
    expect(receiptPathFromStoredValue('user-1/../../etc/passwd')).toBeNull();
    expect(receiptPathFromStoredValue('https://evil.example.com/receipts/x.jpg')).toBeNull();
    expect(receiptPathFromStoredValue('https://xyz.supabase.co/storage/v1/object/public/project-photos/user-1/a.jpg')).toBeNull();
    expect(receiptPathFromStoredValue('')).toBeNull();
    expect(receiptPathFromStoredValue(null)).toBeNull();
  });
});

describe('signed URL minting', () => {
  const client = (impl: (path: string, expiresIn: number) => any) => ({
    storage: {
      from: () => ({ createSignedUrl: impl }),
    },
  });

  it('signs the path with a short lifetime', async () => {
    const createSignedUrl = vi.fn(async (path: string, expiresIn: number) => ({
      data: { signedUrl: `https://signed/${path}?exp=${expiresIn}` },
      error: null,
    }));

    const result = await createReceiptSignedUrl(
      client(createSignedUrl) as any,
      'user-1/123-ab.jpg'
    );

    expect(result.url).toBe('https://signed/user-1/123-ab.jpg?exp=300');
    expect(createSignedUrl).toHaveBeenCalledWith('user-1/123-ab.jpg', 300);
  });

  it('reports a signing failure instead of returning a broken image', async () => {
    const result = await createReceiptSignedUrl(
      client(async () => ({ data: null, error: { message: 'Object not found' } })) as any,
      'user-1/missing.jpg'
    );
    expect(result.url).toBeNull();
    expect(result.error).toMatch(/Object not found/);
  });

  it('does not call storage at all when there is no receipt', async () => {
    const createSignedUrl = vi.fn();
    const result = await createReceiptSignedUrl(client(createSignedUrl) as any, null);
    expect(result.url).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('never throws when the storage client explodes', async () => {
    const result = await createReceiptSignedUrl(
      client(async () => {
        throw new Error('network down');
      }) as any,
      'user-1/123-ab.jpg'
    );
    expect(result.url).toBeNull();
    expect(result.error).toMatch(/network down/);
  });
});
