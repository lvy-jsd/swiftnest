import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MemoryEntry, MemoryView, SwiftnestClient } from '@swiftnest/api';
import { localizedError } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { memoryReducer, initialMemoryState, watchMemoryChanges } from './memoryState';
import { HubPage } from './components/pages';
import { Button } from './components/Button';
import { Card } from './components/Card';

type Perform = (action: (client: SwiftnestClient) => Promise<unknown>) => Promise<boolean>;

function useMemory() {
  const { store, status } = useConnection();
  const client = status === 'connected' ? store.client : undefined;
  const [state, dispatch] = useReducer(memoryReducer, initialMemoryState);
  const active = useRef(client);
  active.current = client;
  const [automatic, setAutomatic] = useState<{ enabled: boolean; entries: MemoryEntry[] }>();
  const read = useCallback(async (target: SwiftnestClient) => {
    const [view, settings, entries] = await Promise.all([
      target.listMemory(),
      target.memoryAutoSettings(),
      target.recentAutoMemory(),
    ]);
    if (active.current === target) setAutomatic({ ...settings, entries });
    return view;
  }, []);
  useMemorySubscription(client, read, dispatch);
  const perform: Perform = useCallback(
    async (action) => {
      if (!client) return false;
      dispatch({ type: 'start' });
      try {
        await action(client);
        const view = await read(client);
        if (active.current !== client) return false;
        dispatch({ type: 'loaded', view });
        return true;
      } catch (error) {
        if (active.current === client) dispatch({ type: 'failed', error });
        return false;
      }
    },
    [client, read],
  );
  return { ...state, automatic, perform, connected: !!client };
}

function useMemorySubscription(
  client: SwiftnestClient | undefined,
  read: (target: SwiftnestClient) => Promise<MemoryView>,
  dispatch: (action: Parameters<typeof memoryReducer>[1]) => void,
) {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    if (client) {
      dispatch({ type: 'start' });
      const refresh = async () => {
        try {
          const view = await read(client);
          if (!disposed) dispatch({ type: 'loaded', view });
        } catch (error) {
          if (!disposed) dispatch({ type: 'failed', error });
        }
      };
      void refresh();
      stop = watchMemoryChanges(client, refresh);
    }
    return () => {
      disposed = true;
      stop?.();
    };
  }, [client, read, dispatch]);
}

export function MemoryPage({ onBack }: { onBack: () => void }) {
  const { t, locale } = useI18n();
  const { view, automatic, busy, error, perform, connected } = useMemory();
  return (
    <HubPage title={t('memory')} subtitle={t('memoryHelp')} onBack={onBack}>
      {error !== undefined && <p role="alert">{localizedError(error, locale).message}</p>}
      {!connected ? (
        <p>{t('pairHelp')}</p>
      ) : (
        <>
          {automatic && (
            <AutomaticMemorySettings
              enabled={automatic.enabled}
              entries={automatic.entries}
              disabled={busy}
              perform={perform}
            />
          )}
          <MemoryAdd disabled={busy} perform={perform} />
          <h2>{t('memoryEntries')}</h2>
          {!view.entries.length && <p>{t('memoryEmpty')}</p>}
          <ul className="memory-entries">
            {view.entries.map((entry) => (
              <MemoryItem key={entry.id} entry={entry} disabled={busy} perform={perform} />
            ))}
          </ul>
          <MemoryTopics view={view} disabled={busy} perform={perform} />
        </>
      )}
    </HubPage>
  );
}

function MemoryTopics({ view, disabled, perform }: { view: MemoryView; disabled: boolean; perform: Perform }) {
  const { t } = useI18n();
  const [topic, setTopic] = useState('');
  return (
    <details>
      <summary>{t('memoryAdvanced')}</summary>
      <h2>{t('memoryTopics')}</h2>
      <div className="memory-actions">
        <Button onClick={() => setTopic('')}>{t('memoryNewTopic')}</Button>
        {view.topics.map((item) => (
          <Button key={item.name} onClick={() => setTopic(item.name)}>
            {item.name}
          </Button>
        ))}
      </div>
      <TopicEditor key={topic} topic={topic} disabled={disabled} perform={perform} />
    </details>
  );
}

export function AutomaticMemorySettings({
  enabled,
  entries,
  disabled,
  perform,
}: {
  enabled: boolean;
  entries: MemoryEntry[];
  disabled: boolean;
  perform: Perform;
}) {
  const { t, locale } = useI18n();
  return (
    <Card className="memory-auto-settings" role="region" aria-label={t('memoryAutoRecent')}>
      <label className="memory-auto-switch">
        <input
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          checked={enabled}
          disabled={disabled}
          onChange={(event) => void perform((client) => client.setMemoryAuto(event.target.checked))}
        />
        {t('memoryAutoSwitch')}
      </label>
      <p>{t('memoryAutoHelp')}</p>
      <h2>{t('memoryAutoRecent')}</h2>
      {!entries.length && <p>{t('memoryAutoEmpty')}</p>}
      <ul className="memory-entries">
        {entries.map((entry) => (
          <li key={entry.id} className="memory-item">
            <p>{entry.text}</p>
            <time dateTime={entry.added}>{new Date(entry.added).toLocaleString(locale)}</time>
            <Button disabled={disabled} onClick={() => void perform((client) => client.deleteMemory(entry.id))}>
              {t('memoryDelete')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MemoryAdd({ disabled, perform }: { disabled: boolean; perform: Perform }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [topic, setTopic] = useState('');
  return (
    <form
      className="memory-form"
      onSubmit={(event) => {
        event.preventDefault();
        void perform((client) => client.addMemory(value, topic || undefined)).then((saved) => {
          if (saved) setValue('');
        });
      }}
    >
      <label>
        {t('memoryEntry')}
        <textarea
          aria-label={t('memoryEntry')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
        />
      </label>
      <label>
        {t('memoryTopicOptional')}
        <input aria-label={t('memoryTopicOptional')} value={topic} onChange={(event) => setTopic(event.target.value)} />
      </label>
      <Button type="submit" disabled={disabled || !value.trim()}>
        {t('memoryAdd')}
      </Button>
    </form>
  );
}

function MemoryItem({ entry, disabled, perform }: { entry: MemoryEntry; disabled: boolean; perform: Perform }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.text);
  return (
    <li className="memory-item">
      {editing ? (
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform((client) => client.editMemory(entry.id, value)).then((saved) => {
              if (saved) setEditing(false);
            });
          }}
        >
          <label>
            {t('memoryEntry')}
            <textarea aria-label={t('memoryEntry')} value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
          <div className="memory-actions">
            <Button type="submit" disabled={disabled}>
              {t('save')}
            </Button>
            <Button onClick={() => setEditing(false)}>{t('cancel')}</Button>
          </div>
        </form>
      ) : (
        <>
          <p>{entry.text}</p>
          <small>
            {entry.topic} {entry.source} · {entry.added}
          </small>
          <div className="memory-actions">
            <Button
              disabled={disabled}
              onClick={() => {
                setValue(entry.text);
                setEditing(true);
              }}
            >
              {t('memoryEdit')}
            </Button>
            <Button disabled={disabled} onClick={() => void perform((client) => client.deleteMemory(entry.id))}>
              {t('memoryDelete')}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

function TopicEditor({ topic, disabled, perform }: { topic: string; disabled: boolean; perform: Perform }) {
  const { t } = useI18n();
  const [name, setName] = useState(topic);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(!topic);
  useEffect(() => {
    let disposed = false;
    if (topic)
      void perform(async (client) => {
        const result = await client.readMemoryTopic(topic);
        if (!disposed) {
          setContent(result.content);
          setLoaded(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [topic, perform]);
  return (
    <form
      className="memory-form"
      onSubmit={(event) => {
        event.preventDefault();
        void perform((client) => client.writeMemoryTopic(name, content));
      }}
    >
      <label>
        {t('memoryTopicName')}
        <input
          aria-label={t('memoryTopicName')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          readOnly={!!topic}
          required
        />
      </label>
      <label>
        {t('memoryTopicContent')}
        <textarea
          aria-label={t('memoryTopicContent')}
          rows={8}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <Button type="submit" disabled={disabled || !loaded || !name}>
        {t('memorySaveTopic')}
      </Button>
    </form>
  );
}
