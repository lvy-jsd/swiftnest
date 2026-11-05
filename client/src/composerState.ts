import type { ImageInput } from '@swiftnest/api';
import type { PhotoDraft } from './photoState';

export type Draft = {
  text: string;
  photos: PhotoDraft[];
  sending: boolean;
  failed: boolean;
  photoFailed: boolean;
  preparing: number;
};
const emptyDraft = (): Draft => ({
  text: '',
  photos: [],
  sending: false,
  failed: false,
  photoFailed: false,
  preparing: 0,
});
export type MessageDraft = { text: string; photos: ImageInput[] };

/** Owned by the shell, so navigation never owns or destroys an unfinished message. */
export class ComposerState {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private sessions = new Map<string, string>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = (key: string): Draft => {
    if (!this.drafts.has(key)) this.drafts.set(key, emptyDraft());
    return this.drafts.get(key)!;
  };
  update(key: string, patch: Partial<Draft>) {
    this.drafts.set(key, { ...this.get(key), ...patch });
    for (const listener of this.listeners) listener();
  }
  remove(key: string, ids: readonly string[]) {
    const photos = this.get(key).photos.filter((photo) => {
      if (!ids.includes(photo.id)) return true;
      URL.revokeObjectURL(photo.url);
      return false;
    });
    this.update(key, { photos });
  }
  async send(
    key: string,
    create: () => Promise<string | undefined>,
    deliver: (id: string, message: MessageDraft) => Promise<unknown>,
  ) {
    const draft = this.get(key);
    if (draft.sending || draft.preparing || (!draft.text.trim() && !draft.photos.length)) return;
    this.update(key, { sending: true, failed: false });
    try {
      const id = key === 'home' ? (this.sessions.get(key) ?? (await create())) : key;
      if (!id) throw new Error('session-unavailable');
      this.sessions.set(key, id);
      const photos = draft.photos.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name ? { name } : {}) }));
      await deliver(id, { text: draft.text.trim(), photos });
      this.remove(
        key,
        draft.photos.map((photo) => photo.id),
      );
      if (this.get(key).text === draft.text) this.update(key, { text: '' });
      this.sessions.delete(key);
      return id;
    } catch {
      this.update(key, { failed: true });
    } finally {
      this.update(key, { sending: false });
    }
  }
  dispose() {
    for (const draft of this.drafts.values()) {
      for (const photo of draft.photos) URL.revokeObjectURL(photo.url);
    }
  }
}
