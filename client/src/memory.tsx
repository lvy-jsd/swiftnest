import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MemoryEntry, SwiftnestClient } from '@swiftnest/api';
import { localizedError } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { memoryReducer, initialMemoryState } from './memoryState';
import { HubPage } from './components/pages';
import { Button } from './components/Button';

type Perform = (action: (client: SwiftnestClient) => Promise<unknown>) => Promise<boolean>;

function useMemory() {
  const { store, status } = useConnection();
  const client = status === 'connected' ? store.client : undefined;
  const [state, dispatch] = useReducer(memoryReducer, initialMemoryState);
  const active = useRef(client);
  active.current = client;
  useEffect(() => {
    let disposed = false;
    if (client) {
      dispatch({ type: 'start' });
      void client.listMemory().then(
        (view) => {
          if (!disposed) dispatch({ type: 'loaded', view });
        },
        (error) => {
          if (!disposed) dispatch({ type: 'failed', error });
        },
      );
    }
    return () => {
      disposed = true;
    };
  }, [client]);
  const perform: Perform = useCallback(
    async (action) => {
      if (!client) return false;
      dispatch({ type: 'start' });
      try {
        await action(client);
        const view = await client.listMemory();
        if (active.current !== client) return false;
        dispatch({ type: 'loaded', view });
        return true;
      } catch (error) {
        if (active.current === client) dispatch({ type: 'failed', error });
        return false;
      }
    },
    [client],
  );
  return { ...state, perform, connected: !!client };
}

export function MemoryPage({ onBack }: { onBack: () => void }) {
  const { t, locale } = useI18n();
  const { view, busy, error, perform, connected } = useMemory();
  const [topic, setTopic] = useState('');
  return (
    <HubPage title={t('memory')} subtitle={t('memoryHelp')} onBack={onBack}>
      {error !== undefined && <p role="alert">{localizedError(error, locale).message}</p>}
      {!connected ? (
        <p>{t('pairHelp')}</p>
      ) : (
        <>
          <MemoryAdd disabled={busy} perform={perform} />
          <h2>{t('memoryEntries')}</h2>
          {!view.entries.length && <p>{t('memoryEmpty')}</p>}
          <ul className="memory-entries">
            {view.entries.map((entry) => (
              <MemoryItem key={entry.id} entry={entry} disabled={busy} perform={perform} />
            ))}
          </ul>
          <h2>{t('memoryTopics')}</h2>
          <div className="memory-actions">
            <Button onClick={() => setTopic('')}>{t('memoryNewTopic')}</Button>
            {view.topics.map((item) => (
              <Button key={item.name} onClick={() => setTopic(item.name)}>
                {item.name}
              </Button>
            ))}
          </div>
          <TopicEditor key={topic} topic={topic} disabled={busy} perform={perform} />
        </>
      )}
    </HubPage>
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
