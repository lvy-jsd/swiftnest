/** Shrinking a picked photo on the device, in the browser or the App's web view. */
import type { ImageInput } from '@swiftnest/api';
import { base64, fitWithin, MAX_PHOTO_BYTES, needsShrinking, photoName, type PhotoDraft } from './photoState';

async function encode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/jpeg', quality),
  );
}

/** Shrink to JPEG, lowering quality and then size until the photo fits. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    let { width, height } = fitWithin(bitmap.width, bitmap.height);
    for (let attempt = 0; attempt < 6; attempt++) {
      const blob = await encode(bitmap, width, height, attempt === 0 ? 0.85 : 0.72);
      if (blob.size <= MAX_PHOTO_BYTES) return blob;
      if (attempt > 0) ({ width, height } = fitWithin(width, height, Math.round(Math.max(width, height) * 0.75)));
    }
    throw new Error('too large');
  } finally {
    bitmap.close();
  }
}

async function dimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

export async function preparePhoto(file: File): Promise<PhotoDraft> {
  const { width, height } = await dimensions(file);
  const blob = needsShrinking(file.type, file.size, width, height) ? await shrink(file) : file;
  const name = photoName(file.name);
  return {
    id: crypto.randomUUID(),
    mediaType: blob.type as ImageInput['mediaType'],
    data: base64(new Uint8Array(await blob.arrayBuffer())),
    url: URL.createObjectURL(blob),
    ...(name ? { name } : {}),
  };
}

/** Prepare each photo; one that cannot be read or shrunk is left out and reported. */
export async function preparePhotos(files: readonly File[]): Promise<{ ok: PhotoDraft[]; failed: boolean }> {
  const prepared = await Promise.allSettled(files.map(preparePhoto));
  const ok = prepared.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  return { ok, failed: ok.length < files.length };
}
