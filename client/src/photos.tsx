/**
 * Photos in chat: pick from the gallery or camera, or paste; preview and remove before
 * sending; and see the photos already in a conversation.
 */
import { useEffect, useRef, useState } from 'react';
import type { ModelsView } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { ChatIcon } from './components/ChatIcon';
import { icons } from './design/icons';
import { needsFreeVisionAnswer, type PhotoDraft } from './photoState';
import { Button } from './components/Button';
import { IconButton } from './components/IconButton';
import { Card } from './components/Card';

export function PhotoButton({
  disabled,
  add,
  lineIcon = false,
}: {
  disabled: boolean;
  add: (files: FileList) => void;
  lineIcon?: boolean;
}) {
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
      <IconButton variant="ghost" aria-label={t('photoAdd')} disabled={disabled} onClick={() => input.current?.click()}>
        {lineIcon ? <ChatIcon name="attach" /> : <Photo size={24} />}
      </IconButton>
    </>
  );
}

export function PhotoDrafts({
  drafts,
  remove,
  lineIcon = false,
}: {
  drafts: readonly PhotoDraft[];
  remove: (id: string) => void;
  lineIcon?: boolean;
}) {
  const { t } = useI18n();
  const Close = icons.close;
  if (!drafts.length) return null;
  return (
    <ul className="photo-drafts" aria-label={t('photoDrafts')}>
      {drafts.map((draft) => (
        <li key={draft.id}>
          <img src={draft.url} alt={draft.name ?? t('photo')} />
          <IconButton variant="ghost" aria-label={t('photoRemove')} onClick={() => remove(draft.id)}>
            {lineIcon ? <ChatIcon name="close" /> : <Close size={16} />}
          </IconButton>
        </li>
      ))}
    </ul>
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
      .catch(() => !ended && setFailed(true));
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
  return { checking: active && !vision, asking: active && !!vision && needsFreeVisionAnswer(vision), failed, answer };
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
