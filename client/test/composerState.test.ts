import { expect, it, vi } from 'vitest';
import { ComposerState } from '../src/composerState';
import type { PhotoDraft } from '../src/photoState';

const photo: PhotoDraft = {
  id: 'photo',
  url: 'blob:photo',
  mediaType: 'image/png',
  data: 'encoded',
  name: 'photo.png',
};

it('keeps the home draft during slow creation, route changes and repeated sends', async () => {
  const state = new ComposerState();
  let finish!: (id: string) => void;
  const create = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const deliver = vi.fn(async () => {});
  state.update('home', { text: 'first message' });
  const sending = state.send('home', create, deliver);
  state.update('home', { text: 'typing while creation is slow' });
  state.update('other-chat', { text: 'another conversation' });
  expect(state.get('home').text).toBe('typing while creation is slow');
  await state.send('home', create, deliver);
  expect(create).toHaveBeenCalledTimes(1);
  finish('created');
  await sending;
  expect(deliver).toHaveBeenCalledWith('created', { text: 'first message', photos: [] });
  expect(state.get('home').text).toBe('typing while creation is slow');
  expect(state.get('other-chat').text).toBe('another conversation');
});

it('sends text and a photo together from home, clearing only acknowledged content', async () => {
  const state = new ComposerState();
  const deliver = vi.fn(async () => {});
  state.update('home', { text: 'look at this', photos: [photo] });
  expect(await state.send('home', async () => 'first-chat', deliver)).toBe('first-chat');
  expect(deliver).toHaveBeenCalledWith('first-chat', {
    text: 'look at this',
    photos: [{ mediaType: photo.mediaType, data: photo.data, name: photo.name }],
  });
  expect(state.get('home')).toMatchObject({ text: '', photos: [], sending: false });
});

it('retains text/photos after a failed send and retries the same created session', async () => {
  const state = new ComposerState();
  const create = vi.fn(async () => 'created');
  state.update('home', { text: 'retry me', photos: [photo] });
  await state.send('home', create, async () => {
    throw new Error('offline');
  });
  expect(state.get('home')).toMatchObject({ text: 'retry me', photos: [photo], failed: true });
  await state.send('home', create, async () => {});
  expect(create).toHaveBeenCalledTimes(1);
  expect(state.get('home')).toMatchObject({ text: '', photos: [], failed: false });
});

it('accepts a photo-only first message and waits for photo preparation', async () => {
  const state = new ComposerState();
  const create = vi.fn(async () => 'photo-chat');
  const deliver = vi.fn(async () => {});
  state.update('home', { preparing: 1 });
  await state.send('home', create, deliver);
  expect(create).not.toHaveBeenCalled();
  state.update('home', { preparing: 0, photos: [photo] });
  await state.send('home', create, deliver);
  expect(deliver).toHaveBeenCalledWith('photo-chat', {
    text: '',
    photos: [{ mediaType: photo.mediaType, data: photo.data, name: photo.name }],
  });
});
