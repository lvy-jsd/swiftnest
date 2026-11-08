import { describe, expect, it } from 'vitest';
import { chatReducer, emptyChat } from '../src/chat';
import {
  base64,
  fitWithin,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  needsFreeVisionAnswer,
  needsShrinking,
  photoName,
  roomFor,
} from '../src/photoState';

describe('photo rules', () => {
  it('scales the longest side down to the limit and never up', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it('sends small photos in server formats untouched and shrinks the rest', () => {
    expect(needsShrinking('image/jpeg', 300_000, 1600, 1200)).toBe(false);
    expect(needsShrinking('image/heic', 300_000, 1600, 1200)).toBe(true);
    expect(needsShrinking('image/png', MAX_PHOTO_BYTES + 1, 1600, 1200)).toBe(true);
    expect(needsShrinking('image/png', 300_000, 4032, 3024)).toBe(true);
  });
  it('keeps at most four photos per message', () => {
    const draft = { id: 'x', url: 'blob:x', mediaType: 'image/png' as const, data: '' };
    expect(roomFor([])).toBe(MAX_PHOTOS);
    expect(roomFor(Array(MAX_PHOTOS + 1).fill(draft))).toBe(0);
  });
  it('shows only a picked file name, never its folder', () => {
    expect(photoName('C:\\Users\\me\\Pictures\\cat.png')).toBe('cat.png');
    expect(photoName('/home/me/cat.png')).toBe('cat.png');
    expect(photoName('   ')).toBeUndefined();
  });
  it('encodes large photos to base64 without overflowing the call stack', () => {
    const bytes = new Uint8Array(300_000).fill(7);
    expect(Buffer.from(base64(bytes), 'base64')).toEqual(Buffer.from(bytes));
  });
});

it('keeps the photos of a sent message in the transcript, also without text', () => {
  const images = [{ attachmentId: 'sha256:a', mediaType: 'image/jpeg' as const, bytes: 1000, width: 10, height: 10 }];
  const state = chatReducer(emptyChat(), {
    type: 'user-message',
    sessionId: 's',
    seq: 1,
    messageId: 'm',
    text: '',
    images,
  });
  expect(state.rows[0]).toMatchObject({ kind: 'message', role: 'user', text: '', images });
});

it('asks about the free photo service only when nothing else can read photos and the owner has not answered', () => {
  expect(needsFreeVisionAnswer({ needed: true, readers: [], free: 'ask' })).toBe(true);
  expect(needsFreeVisionAnswer({ needed: true, readers: ['google'], free: 'ask' })).toBe(false);
  expect(needsFreeVisionAnswer({ needed: true, readers: [], free: 'off' })).toBe(false);
  expect(needsFreeVisionAnswer({ needed: false, readers: [], free: 'ask' })).toBe(false);
});
