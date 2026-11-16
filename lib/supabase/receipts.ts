/**
 * Receipt storage helpers.
 *
 * The `receipts` bucket is PRIVATE (see migration
 * 20261006000000_security_hardening.sql). Consequences, which this module
 * encapsulates:
 *
 *   1. `expenses.receipt_url` stores the STORAGE PATH, not a URL. A stored
 *      public URL leaks the photo to anyone who ever sees the row.
 *   2. Reading a photo requires a short-lived SIGNED URL, minted on demand by
 *      a Founder session (the `createSignedUrl` call enforces the bucket's
 *      SELECT policy).
 *   3. The object extension is derived from the MIME allowlist, never from
 *      `file.name`. A filename is attacker-controlled: `receipt.php.jpg` or a
 *      name with no extension at all previously decided the stored extension.
 *
 * Nothing here writes to the ledger and nothing here trusts the browser.
 */

/** App-level upload limit. Verify storage bucket limits independently at deployment. */
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

/** Signed URL lifetime. Long enough to render, short enough to be useless if leaked. */
export const RECEIPT_SIGNED_URL_TTL_SECONDS = 300;

export const RECEIPT_BUCKET = 'receipts';

/**
 * The extension allowlist. The stored object extension is the map value for the
 * browser-reported MIME type — the filename is ignored entirely.
 */
export const RECEIPT_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const RECEIPT_ALLOWED_MIME_TYPES = Object.keys(RECEIPT_MIME_EXTENSIONS);

/** Canonicalize the common JPEG alias before supplying a Storage content type. */
export function canonicalReceiptMime(type: string | undefined): string | null {
  const value = (type || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RECEIPT_MIME_EXTENSIONS, value)) return null;
  return value === 'image/jpg' ? 'image/jpeg' : value;
}

/** Storage SDK sends Blob/File.type in multipart uploads, not its contentType option. */
export function canonicalReceiptUpload(file: File): File {
  const mime = canonicalReceiptMime(file.type);
  if (!mime) throw new Error('Unsupported receipt type.');
  return file.type === mime ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

export interface ReceiptFileCheck {
  ok: boolean;
  /** Safe, user-facing reason when ok is false. */
  error?: string;
  /** Extension to persist, derived from the MIME type. */
  extension?: string;
}

/** Client-side validation; storage bucket configuration must be verified separately. */
export function validateReceiptFile(file: { type?: string; size?: number } | null): ReceiptFileCheck {
  if (!file) {
    return { ok: false, error: 'Choose a receipt photo first.' };
  }

  const mime = canonicalReceiptMime(file.type);
  const extension = mime ? RECEIPT_MIME_EXTENSIONS[mime] : undefined;
  if (!extension) {
    return {
      ok: false,
      error: `Receipts must be one of: ${RECEIPT_ALLOWED_MIME_TYPES.join(', ')}. That file type is not accepted.`,
    };
  }

  const size = typeof file.size === 'number' ? file.size : 0;
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, error: 'That file is empty.' };
  }
  if (size > RECEIPT_MAX_BYTES) {
    return {
      ok: false,
      error: `Receipt photos must be smaller than ${Math.round(RECEIPT_MAX_BYTES / (1024 * 1024))} MB.`,
    };
  }

  return { ok: true, extension };
}

/**
 * Extracts the storage path from whatever is stored in `expenses.receipt_url`.
 *
 * Handles three shapes so the UI keeps working across the migration:
 *   - the path we now store:            "user-id/1234-ab.jpg"
 *   - a legacy public URL:              ".../object/public/receipts/user-id/1234-ab.jpg"
 *   - a legacy signed URL with a token: ".../object/sign/receipts/…?token=…"
 *
 * Only receipt-bucket URLs are converted; their host is not validated because
 * only the extracted path is passed to the configured Storage client. Reject
 * traversal and empty paths. The caller renders
 * "no receipt" rather than pretending a photo is available.
 */
export function receiptPathFromStoredValue(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;

  let candidate = value.trim();
  if (!candidate) return null;

  if (/^https?:\/\//i.test(candidate)) {
    // Strip the query string first: a signed URL's token must not be treated
    // as part of the path.
    candidate = candidate.split('?')[0];
    const marker = candidate.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/receipts\/(.+)$/);
    if (!marker) return null;
    candidate = marker[1];
  }

  candidate = candidate.replace(/^\/+/, '');
  if (!candidate) return null;
  // Block traversal and anything that is not a plain path.
  if (candidate.includes('..') || candidate.includes('\\')) return null;
  if (/%2e%2e/i.test(candidate)) return null;

  return candidate;
}

/**
 * Builds the object path for a new upload: `<founder-id>/<timestamp>-<random>.<ext>`.
 * Randomised so two receipts captured in the same millisecond cannot collide.
 */
export function buildReceiptObjectPath(
  userId: string,
  extension: string,
  options: { now?: number; random?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const random =
    options.random ?? Math.random().toString(36).slice(2, 8);
  const safeUserId = (userId || 'unattributed').replace(/[^a-zA-Z0-9-]/g, '');
  const safeExtension = RECEIPT_ALLOWED_MIME_TYPES.length > 0 && extension ? extension.replace(/[^a-z0-9]/gi, '') : 'jpg';
  return `${safeUserId || 'unattributed'}/${now}-${random}.${safeExtension || 'jpg'}`;
}

export interface SignedReceiptUrlResult {
  url: string | null;
  error?: string;
}

interface StorageSigner {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresIn: number
      ) => PromiseLike<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    };
  };
}

/**
 * Mints a short-lived signed URL for a stored receipt path.
 *
 * Never throws. A failure returns `{ url: null, error }` so the UI can say
 * "the receipt photo could not be loaded" instead of showing a broken image.
 */
export async function createReceiptSignedUrl(
  client: StorageSigner,
  storedValue: string | null | undefined,
  expiresIn: number = RECEIPT_SIGNED_URL_TTL_SECONDS
): Promise<SignedReceiptUrlResult> {
  const path = receiptPathFromStoredValue(storedValue);
  if (!path) {
    return { url: null, error: 'This expense has no stored receipt photo.' };
  }

  try {
    const { data, error } = await client.storage.from(RECEIPT_BUCKET).createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl) {
      return {
        url: null,
        error: `Could not sign the receipt URL: ${error?.message || 'unknown storage error'}`,
      };
    }
    return { url: data.signedUrl };
  } catch (caught) {
    return {
      url: null,
      error: `Could not sign the receipt URL: ${
        caught instanceof Error ? caught.message : 'unexpected storage error'
      }`,
    };
  }
}
