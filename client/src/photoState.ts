import type { ModelsView } from '@swiftnest/api';
/**
 * Photos the App attaches to a message. The device shrinks each photo before sending, so a
 * message with photos fits one encrypted channel record and uploads quickly on mobile data.
 * The server stores its own normalized copy.
 */
import type { ImageInput } from '@swiftnest/api';

export const MAX_PHOTOS = 4;
/** Longest side after shrinking: enough for screenshots and documents to stay readable. */
export const MAX_SIDE = 2048;
/** Encoded bytes per photo; four of them, base64 encoded, stay under the 7 MiB prompt limit. */
export const MAX_PHOTO_BYTES = 1_200_000;
const SENT_AS_IS: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export type PhotoDraft = ImageInput & { id: string; url: string };

/** Width and height scaled down to fit `max` on the longest side; never scaled up. */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A small photo in a format the server takes is sent untouched; anything else is shrunk to JPEG. */
export function needsShrinking(type: string, bytes: number, width: number, height: number): boolean {
  return !SENT_AS_IS.includes(type) || bytes > MAX_PHOTO_BYTES || Math.max(width, height) > MAX_SIDE;
}

/** How many more photos fit in this message. */
export const roomFor = (drafts: readonly PhotoDraft[]) => Math.max(0, MAX_PHOTOS - drafts.length);

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Strip a picked file's name to what is safe to show; the server never treats it as a path. */
export function photoName(name: string): string | undefined {
  const leaf = name.split(/[\\/]/).pop()?.trim().slice(0, 80);
  return leaf || undefined;
}

/** Files the photo picker and paste accept. */
export const isPhoto = (file: File) => file.type.startsWith('image/');

/** The main model cannot see, nothing else reads photos, and the owner has not said whether the free service may. */
export function needsFreeVisionAnswer(vision: ModelsView['vision']): boolean {
  return vision.needed && !vision.readers.length && vision.free === 'ask';
}
