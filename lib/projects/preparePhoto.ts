'use client';

import { PROJECT_PHOTO_MAX_BYTES, PROJECT_PHOTO_MIME_TYPES } from './photos';

export const PROJECT_PHOTO_SELECTION_MAX_BYTES = 20 * 1024 * 1024;
const MAX_EDGE = 1920;
const MAX_PIXELS = 80_000_000;

export function checkProjectPhotoSelection(file: { type: string; size: number } | null): string | null {
  if (!file) return 'Choose a photo first.';
  if (!(PROJECT_PHOTO_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())) return 'Choose a JPEG, PNG or WebP photo.';
  if (!file.size) return 'That photo is empty.';
  if (file.size > PROJECT_PHOTO_SELECTION_MAX_BYTES) return 'Choose a photo no larger than 20 MB.';
  return null;
}

/** Resize on this device. Never send the unoptimized source if preparation fails. */
export async function prepareProjectPhoto(file: File): Promise<File> {
  const invalid = checkProjectPhotoSelection(file);
  if (invalid) throw new Error(invalid);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not read this photo. Try a different JPEG, PNG or WebP.'));
      image.src = url;
    });
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('This photo has too many pixels to process. Try a smaller image.');
    let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.toBlob) throw new Error('This browser could not prepare the photo. Try a different browser.');
    // Preserve transparency for PNG/WebP; browsers without WebP encoding can
    // return PNG, which is still accepted. Never silently flatten alpha to JPEG.
    const requestedType = file.type.toLowerCase() === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, requestedType, 0.84));
      if (!blob || !(PROJECT_PHOTO_MIME_TYPES as readonly string[]).includes(blob.type)) break;
      if (blob.size > 0 && blob.size <= PROJECT_PHOTO_MAX_BYTES) {
        const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
        return new File([blob], `project-photo.${ext}`, { type: blob.type });
      }
      scale *= 0.75;
    }
    throw new Error('Could not make this photo small enough. Try a different photo.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
