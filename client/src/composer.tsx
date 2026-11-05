import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import { ComposerState } from './composerState';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { PhotoButton, PhotoConsent, PhotoDrafts, usePhotoConsent } from './photos';
import { preparePhotos } from './photoEncode';
import { isPhoto, roomFor } from './photoState';
import { hasPrecisePointer } from './runtime';
import { icons } from './design/icons';
import { IconButton } from './components/IconButton';

const Context = createContext<ComposerState | null>(null);
export function ComposerProvider({ children }: PropsWithChildren) {
  const [state] = useState(() => new ComposerState());
  useEffect(() => () => state.dispose(), [state]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
export function useComposerDraft(key: string) {
  const state = useContext(Context)!;
  const draft = useSyncExternalStore(
    state.subscribe,
    () => state.get(key),
    () => state.get(key),
  );
  const add = async (files: Iterable<File>) => {
    const images = [...files].filter(isPhoto).slice(0, roomFor(state.get(key).photos));
    state.update(key, { preparing: state.get(key).preparing + 1 });
    const { ok, failed } = await preparePhotos(images);
    const photos = state.get(key).photos;
    const accepted = ok.slice(0, roomFor(photos));
    for (const photo of ok.slice(accepted.length)) URL.revokeObjectURL(photo.url);
    state.update(key, {
      photos: [...photos, ...accepted],
      photoFailed: failed,
      preparing: state.get(key).preparing - 1,
    });
  };
  return { state, draft, add, setText: (text: string) => state.update(key, { text }) };
}

function useSendDraft(draftKey: string) {
  const { store, status } = useConnection();
  const { state, ...draft } = useComposerDraft(draftKey);
  const send = async () => {
    const client = store.client;
    if (!client || status !== 'connected') return;
    const origin = window.location.hash;
    const id = await state.send(
      draftKey,
      () => store.newChat(),
      async (id, message) => {
        // Establish observation before delivery, including the first message from home.
        const subscription = await client.follow(id);
        try {
          await client.sendMessage(id, message.text, message.photos);
        } finally {
          subscription.close();
        }
      },
    );
    if (!id) return;
    void store.refresh();
    if (draftKey === 'home' && window.location.hash === origin)
      window.location.hash = `/chats/${encodeURIComponent(id)}`;
  };
  return { state, ...draft, send };
}

function ComposerInput({ model }: { model: ReturnType<typeof useSendDraft> }) {
  const { t } = useI18n();
  return (
    <textarea
      data-composer
      aria-label={t('composer')}
      placeholder={t('composer')}
      rows={1}
      value={model.draft.text}
      onChange={(event) => model.setText(event.target.value)}
      onPaste={(event) => {
        const files = [...event.clipboardData.files].filter(isPhoto);
        if (!files.length) return;
        event.preventDefault();
        void model.add(files);
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
  );
}

function ComposerForm({ model, disabled }: { model: ReturnType<typeof useSendDraft>; disabled: boolean }) {
  const { t } = useI18n();
  const Send = icons.send;
  return (
    <form
      className="composer card"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void model.send();
      }}
    >
      <PhotoButton disabled={roomFor(model.draft.photos) === 0} add={(files) => void model.add(files)} />
      <ComposerInput model={model} />
      <IconButton
        type="submit"
        variant="primary"
        disabled={disabled || (!model.draft.text.trim() && !model.draft.photos.length)}
        aria-label={t('send')}
      >
        <Send size={24} />
      </IconButton>
    </form>
  );
}

export function Composer({
  draftKey,
  ready = true,
  waiting = false,
}: {
  draftKey: string;
  ready?: boolean;
  waiting?: boolean;
}) {
  const { t } = useI18n();
  const { status } = useConnection();
  const model = useSendDraft(draftKey);
  const { draft, state } = model;
  const consent = usePhotoConsent(draft.photos.length > 0);
  const [hasKeyboard] = useState(hasPrecisePointer);
  const disabled =
    !ready || status !== 'connected' || draft.sending || draft.preparing > 0 || consent.asking || consent.checking;
  return (
    <div className="composer-area">
      {(waiting || hasKeyboard) && <p className="composer-notice">{t(waiting ? 'queueHelp' : 'sendHelp')}</p>}
      {draft.failed && <p role="alert">{t('sendFailed')}</p>}
      {draft.photoFailed && <p role="alert">{t('photoFailed')}</p>}
      {consent.failed && <p role="alert">{t('pluginsRequestFailed')}</p>}
      <PhotoDrafts drafts={draft.photos} remove={(id) => state.remove(draftKey, [id])} />
      <PhotoConsent consent={consent} />
      <ComposerForm model={model} disabled={disabled} />
    </div>
  );
}
