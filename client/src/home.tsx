import { useEffect, useRef, useState } from 'react';
import { DeviceApprovals } from './devices';
import { TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { IconButton } from './components/IconButton';
import { useConnection } from './connection';
import { icons } from './design/icons';
import { useI18n } from './i18n';
import { greetingKey } from './shellState';
import { OnlineSummary } from './shell';

export function Suggestions({ onChoose }: { onChoose: (text: string) => void }) {
  const { t } = useI18n();
  const suggestions = [
    { key: 'home.plan', Icon: icons.plan },
    { key: 'home.explain', Icon: icons.chat },
    { key: 'home.write', Icon: icons.write },
    { key: 'home.ideas', Icon: icons.ideas },
  ] as const;
  return (
    <div className="suggestions">
      {suggestions.map(({ key, Icon }) => (
        <button type="button" className="suggestion card" key={key} onClick={() => onChoose(t(key))}>
          <Icon size={24} aria-hidden="true" />
          <span>{t(key)}</span>
        </button>
      ))}
    </div>
  );
}

function Greeting() {
  const { t } = useI18n();
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const Nest = icons.chat;
  return (
    <div className="home-greeting">
      <span className="home-emblem">
        <Nest size={32} aria-hidden="true" />
      </span>
      <h1>{t(greetingKey(hour))}</h1>
      <OnlineSummary />
    </div>
  );
}

function HomeComposer({
  draft,
  setDraft,
  composer,
  creating,
  onSend,
}: {
  draft: string;
  setDraft: (value: string) => void;
  composer: React.RefObject<HTMLTextAreaElement | null>;
  creating: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { status } = useConnection();
  const Send = icons.send;
  return (
    <form
      className="composer card"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() && !creating && status === 'connected') void onSend(draft.trim());
      }}
    >
      <textarea
        ref={composer}
        rows={1}
        aria-label={t('composer')}
        placeholder={t('composer')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <IconButton
        type="submit"
        variant="primary"
        aria-label={t('send')}
        disabled={!draft.trim() || status !== 'connected' || creating}
      >
        <Send size={24} />
      </IconButton>
    </form>
  );
}

export function Home({ onSend, creating }: { onSend: (text: string) => Promise<boolean>; creating: boolean }) {
  const [draft, setDraft] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  return (
    <section className="home">
      <div className="home-notices">
        <DeviceApprovals compact />
        <TransferCards compact />
        <LiveDeviceButton />
      </div>
      <div className="home-center">
        <Greeting />
        <Suggestions
          onChoose={(text) => {
            setDraft(text);
            composer.current?.focus();
          }}
        />
      </div>
      <HomeComposer draft={draft} setDraft={setDraft} composer={composer} creating={creating} onSend={onSend} />
    </section>
  );
}
