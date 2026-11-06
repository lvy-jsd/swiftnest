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
        <button
          type="button"
          className="suggestion card"
          key={key}
          aria-label={t(key)}
          aria-describedby={`${key}-subtitle`}
          onClick={() => onChoose(t(key))}
        >
          <Icon size={24} aria-hidden="true" />
          <span className="suggestion__title">{t(key)}</span>
          <span className="suggestion__subtitle" id={`${key}-subtitle`}>
            {t(`${key}.subtitle`)}
          </span>
        </button>
      ))}
    </div>
  );
}

function Greeting({ hour }: { hour: number }) {
  const { t } = useI18n();
  return (
    <div className="home-greeting">
      <BrandMark emblem />
      <h1>{t(greetingKey(hour))}</h1>
      <OnlineSummary />
    </div>
  );
}

export function Home({ hour }: { hour: number }) {
  const { setText } = useComposerDraft('home');
  return (
    <section className="home">
      <div className="home-notices">
        <DeviceApprovals />
        <TransferCards compact />
        <LiveDeviceButton />
      </div>
      <div className="home-center">
        <Greeting hour={hour} />
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
