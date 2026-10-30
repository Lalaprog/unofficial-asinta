/** Resolve a receipt before attempting the expense write. A failed upload must
 * never silently turn a selected receipt into an expense with no receipt. */
export async function resolveReceiptForSubmission<T>(
  existingPath: string | null,
  pendingFile: T | null,
  upload: (file: T) => Promise<string | null>
): Promise<{ ok: true; path: string | null } | { ok: false }> {
  if (existingPath) return { ok: true, path: existingPath };
  if (!pendingFile) return { ok: true, path: null };
  try {
    const path = await upload(pendingFile);
    return path ? { ok: true, path } : { ok: false };
  } catch {
    return { ok: false };
  }
}
