'use client';

export const SUPERVISOR_PORTRAIT_MAX_BYTES = 256 * 1024;
export const SUPERVISOR_PORTRAIT_SELECTION_MAX_BYTES = 20 * 1024 * 1024;
const types = ['image/jpeg', 'image/png', 'image/webp'];

/** Resize on the device; only the prepared image is uploaded. */
export async function prepareSupervisorPortrait(file: File): Promise<{mime: string; data: string}> {
  if (!types.includes(file.type.toLowerCase()) || !file.size || file.size > SUPERVISOR_PORTRAIT_SELECTION_MAX_BYTES) {
    throw new Error('Choose a nonempty JPEG, PNG or WebP no larger than 20 MB.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('This photo could not be read.'));
      image.src = url;
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || width * height > 80_000_000) throw new Error('This image is too large to process.');
    let scale = Math.min(1, 512 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.toBlob) throw new Error('This browser could not prepare the photo.');
    for (let i = 0; i < 6; i++) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type.toLowerCase() === 'image/jpeg' ? 'image/jpeg' : 'image/webp', 0.82));
      if (!blob || !types.includes(blob.type)) break;
      if (blob.size && blob.size <= SUPERVISOR_PORTRAIT_MAX_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { mime: blob.type, data: btoa(binary) };
      }
      scale *= 0.75;
    }
    throw new Error('Could not prepare a small enough photo. Try another image.');
  } finally { URL.revokeObjectURL(url); }
}
