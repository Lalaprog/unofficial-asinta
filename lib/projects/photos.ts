export const PROJECT_PHOTO_BUCKET = 'project-photos';
export const PROJECT_PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const PROJECT_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ProjectPhotoType = typeof PROJECT_PHOTO_MIME_TYPES[number];

export function checkProjectPhoto(file: { type: string; size: number } | null): string | null {
  if (!file) return 'Choose a photo first.';
  if (!(PROJECT_PHOTO_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())) return 'Choose a JPEG, PNG or WebP photo.';
  if (!file.size) return 'That photo is empty.';
  if (file.size > PROJECT_PHOTO_MAX_BYTES) return 'Choose a photo no larger than 3 MB.';
  return null;
}

/** Reject mismatched or plainly non-image uploads; do not trust filenames. */
export function photoMatchesType(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
  if (mime === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  return false;
}
