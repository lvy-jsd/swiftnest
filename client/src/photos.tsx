/**
 * Photos in chat: pick from the gallery or camera, or paste; preview and remove before
 * sending; and see the photos already in a conversation.
 */
import { useEffect, useRef, useState } from 'react';
import type { ImageInput, MessageImage, ModelsView } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { icons } from './design/icons';
import { preparePhotos } from './photoEncode';
import { isPhoto, needsFreeVisionAnswer, roomFor, type PhotoDraft } from './photoState';
import { Button } from './components/Button';
import { Card } from './components/Card';

/** Photos waiting to go with the next message. */
export function usePhotoDrafts() {
  const [drafts, setDrafts] = useState<PhotoDraft[]>([]);
  const [failed, setFailed] = useState(false);
  const current = useRef(drafts);
  current.current = drafts;
  useEffect(
    () => () => {
      for (const draft of current.current) URL.revokeObjectURL(draft.url);
    },
    [],
  );
  async function add(files: Iterable<File>) {
    const images = [...files].filter(isPhoto).slice(0, roomFor(current.current));
    const { ok, failed: someFailed } = await preparePhotos(images);
    setFailed(someFailed);
    setDrafts((list) => [...list, ...ok].slice(0, list.length + roomFor(list)));
  }
  function remove(id: string) {
    setDrafts((list) => {
      const removed = list.find((draft) => draft.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return list.filter((draft) => draft.id !== id);
    });
  }
  /** Hand the photos to a message and clear the previews. */
  function take(): ImageInput[] {
    const taken = current.current.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name ? { name } : {}) }));
    for (const draft of current.current) URL.revokeObjectURL(draft.url);
    setDrafts([]);
    setFailed(false);
    return taken;
  }
  return { drafts, failed, add, remove, take, full: roomFor(drafts) === 0 };
}

export function PhotoButton({ disabled, add }: { disabled: boolean; add: (files: FileList) => void }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const Photo = icons.photo;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) add(event.target.files);
          event.target.value = '';
        }}
      />
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('photoAdd')}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Photo size={24} />
      </Button>
    </>
  );
}

export function PhotoDrafts({ drafts, remove }: { drafts: readonly PhotoDraft[]; remove: (id: string) => void }) {
  const { t } = useI18n();
  const Close = icons.close;
  if (!drafts.length) return null;
  return (
    <ul className="photo-drafts" aria-label={t('photoDrafts')}>
      {drafts.map((draft) => (
        <li key={draft.id}>
          <img src={draft.url} alt={draft.name ?? t('photo')} />
          <Button variant="ghost" iconOnly aria-label={t('photoRemove')} onClick={() => remove(draft.id)}>
            <Close size={16} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function StoredPhoto({ sessionId, image }: { sessionId: string; image: MessageImage }) {
  const { t } = useI18n();
  const { store, status } = useConnection();
  const [src, setSrc] = useState<string>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!store.client || status !== 'connected' || src) return;
    let ended = false;
    store.client
      .readImage(sessionId, image)
      .then((url) => !ended && setSrc(url))
      .catch(() => !ended && setMissing(true));
    return () => {
      ended = true;
    };
  }, [store, status, sessionId, image, src]);
  if (missing) return <span className="photo-missing">{t('photoUnavailable')}</span>;
  return (
    <img
      src={src}
      alt={image.name ?? t('photo')}
      width={image.width}
      height={image.height}
      className="message-photo"
      loading="lazy"
    />
  );
}

/** Photos sent with a message, loaded from the server as they come into view. */
export function MessagePhotos({ sessionId, images }: { sessionId: string; images?: readonly MessageImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="message-photos">
      {images.map((image) => (
        <StoredPhoto key={image.attachmentId} sessionId={sessionId} image={image} />
      ))}
    </div>
  );
}

/**
 * Once photos are about to be sent, check whether the owner still has to say if the free
 * photo reading service may see them. Only the owner can read or answer this.
 */
export function usePhotoConsent(active: boolean) {
  const { store, status } = useConnection();
  const [vision, setVision] = useState<ModelsView['vision']>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || status !== 'connected' || !store.client) return;
    let ended = false;
    store.client
      .listModels()
      .then((view) => !ended && setVision(view.vision))
      .catch(() => {});
    return () => {
      ended = true;
    };
  }, [active, status, store]);
  async function answer(agree: boolean) {
    try {
      const view = await store.client!.updateModels({ freeVision: agree ? 'on' : 'off' });
      setVision(view.vision);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return { asking: active && !!vision && needsFreeVisionAnswer(vision), failed, answer };
}

/** The one-time question: may photos go to the free photo reading service? */
export function PhotoConsent({ consent }: { consent: ReturnType<typeof usePhotoConsent> }) {
  const { t } = useI18n();
  if (!consent.asking) return null;
  return (
    <Card className="photo-consent" role="group" aria-labelledby="photo-consent-title">
      <p className="model-label" id="photo-consent-title">
        {t('photoConsentTitle')}
      </p>
      <p className="plugin-muted">{t('photoConsentHelp')}</p>
      {consent.failed && <p role="alert">{t('pluginsRequestFailed')}</p>}
      <div className="model-actions">
        <Button variant="primary" onClick={() => void consent.answer(true)}>
          {t('photoConsentAgree')}
        </Button>
        <Button variant="ghost" onClick={() => void consent.answer(false)}>
          {t('photoConsentDecline')}
        </Button>
      </div>
    </Card>
  );
}
