import { useEffect, useState } from 'react';
import { DeviceApprovals } from './devices';
import { TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { Composer, useComposerDraft } from './composer';
import { BrandMark } from './shell';
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
  return (
    <div className="home-greeting">
      <BrandMark emblem />
      <h1>{t(greetingKey(hour))}</h1>
      <OnlineSummary />
    </div>
  );
}

export function Home() {
  const { setText } = useComposerDraft('home');
  return (
    <section className="home">
      <div className="home-notices">
        <DeviceApprovals />
        <TransferCards compact />
        <LiveDeviceButton />
      </div>
      <div className="home-center">
        <Greeting />
        <Suggestions
          onChoose={(text) => {
            setText(text);
            document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus();
          }}
        />
      </div>
      <Composer draftKey="home" />
    </section>
  );
}
