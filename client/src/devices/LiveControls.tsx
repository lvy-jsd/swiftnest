import { ArrowLeftIcon, HandIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { Pill } from '../components/Pill';
import { Card } from '../components/Card';
import { ListRow } from '../components/ListRow';
import { useI18n } from '../i18n';
import type { SendInput } from './useRemoteScreen';

export function LiveHeader({ name, control, onClose }: { name: string; control: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <header className="live-header">
      <IconButton aria-label={t('closeLiveView')} onClick={onClose}>
        <ArrowLeftIcon size={24} />
      </IconButton>
      <div className="live-title">
        <h2>{name}</h2>
        <Pill dot tone={control === 'paused' ? 'neutral' : 'accent'} role="status">
          {t(control === 'owner' ? 'youControl' : control === 'ivy' ? 'ivyControl' : 'livePaused')}
        </Pill>
      </div>
    </header>
  );
}

export function LiveToolbar({
  owner,
  pending,
  onTakeOver,
  onHandBack,
}: {
  owner: boolean;
  pending: boolean;
  onTakeOver?: () => void;
  onHandBack?: () => void;
}) {
  const { t } = useI18n();
  const action = owner ? onHandBack : onTakeOver;
  if (!action) return null;
  return (
    <div className="live-toolbar" role="toolbar" aria-label={t('liveView')}>
      <Button variant="primary" disabled={pending} onClick={action}>
        <HandIcon size={20} aria-hidden="true" />
        {t(owner ? 'handBack' : 'liveTakeOver')}
      </Button>
    </div>
  );
}

export function LiveTools({ owner, onReset, send }: { owner: boolean; onReset: () => void; send: SendInput }) {
  const { t } = useI18n();
  const [keyboard, setKeyboard] = useState(false);
  return (
    <Card className="live-tools">
      <ListRow title={t('liveView')} subtitle={t('liveControlHelp')} />
      <div className="device-actions">
        <Button variant="soft" onClick={onReset}>
          {t('resetView')}
        </Button>
        {owner && (
          <Button variant="soft" aria-expanded={keyboard} onClick={() => setKeyboard((value) => !value)}>
            {t('remoteKeyboard')}
          </Button>
        )}
      </div>
      {keyboard && owner && <RemoteKeyboard send={send} />}
    </Card>
  );
}

function RemoteKeyboard({ send }: { send: SendInput }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  return (
    <form
      className="live-keyboard"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text) return;
        send('input_type', { text });
        setText('');
      }}
    >
      <textarea
        aria-label={t('remoteKeyboard')}
        rows={2}
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
      />
      <Button variant="primary" type="submit" disabled={!text}>
        {t('send')}
      </Button>
      <div className="live-key-row">
        {['Return', 'BackSpace', 'Tab', 'Escape', 'ctrl+c', 'ctrl+v', 'Left', 'Right', 'Up', 'Down'].map((key) => (
          <Button key={key} type="button" variant="soft" onClick={() => send('input_key', { key })}>
            {key}
          </Button>
        ))}
      </div>
    </form>
  );
}
