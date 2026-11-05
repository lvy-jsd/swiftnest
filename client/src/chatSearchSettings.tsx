import { useEffect, useState } from 'react';
import { localizedError, type ChatSearchSettings, type ChatSearchStatus } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n, type StringKey } from './i18n';
import { usePlugins } from './plugins';
import { Button } from './components/Button';

function useSearchSettings() {
  const { store } = useConnection();
  const client = store.client;
  const [view, setView] = useState<ChatSearchStatus>();
  const [settings, setSettings] = useState<ChatSearchSettings>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (client) return;
    setBusy(false);
    setView(undefined);
    setSettings(undefined);
    setError(undefined);
  }, [client]);
  const act = async (action: 'load' | 'save' | 'rebuild') => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      const next =
        action === 'save' && settings
          ? await client.configureChatSearch(settings)
          : action === 'rebuild'
            ? await client.rebuildChatSearch()
            : await client.chatSearchStatus();
      if (client !== store.client) return;
      setView(next);
      setSettings(next.settings);
    } catch (error) {
      if (client === store.client) setError(error);
    } finally {
      if (client === store.client) setBusy(false);
    }
  };
  return { view, settings, setSettings, error, busy, act };
}
export function ChatSearchAdvanced() {
  const { owner } = usePlugins();
  const { t } = useI18n();
  const state = useSearchSettings();
  if (!owner) return null;
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) void state.act('load');
      }}
    >
      <summary>{t('chatSearchAdvanced')}</summary>
      <p>{t('chatSearchHelp')}</p>
      {state.view && (
        <p role="status">
          {t('chatSearchIndexed')}: {state.view.indexedMessages}
        </p>
      )}
      {state.view && (
        <p>
          {t(
            !state.view.settings.enabled
              ? 'chatSearchDisabled'
              : !state.view.settings.semantic
                ? 'chatSearchSemanticOff'
                : state.view.semantic
                  ? 'chatSearchSemanticReady'
                  : 'chatSearchSemanticUnavailable',
          )}
        </p>
      )}
      {state.view?.indexingFailed && <p role="alert">{t('chatSearchFailed')}</p>}
      {state.settings && (
        <SearchSettingsFields settings={state.settings} onChange={state.setSettings} disabled={state.busy} />
      )}
      <Button disabled={state.busy || !state.settings} onClick={() => void state.act('save')}>
        {t('save')}
      </Button>
      <Button disabled={state.busy || !state.settings} onClick={() => void state.act('rebuild')}>
        {t('chatSearchRebuild')}
      </Button>
      {state.error ? <p role="alert">{localizedError(state.error).message}</p> : null}
    </details>
  );
}

type FieldsProps = {
  settings: ChatSearchSettings;
  onChange: (value: ChatSearchSettings) => void;
  disabled: boolean;
};
function SearchSettingsFields({ settings, onChange, disabled }: FieldsProps) {
  return (
    <fieldset disabled={disabled} className="chat-search-settings">
      <SearchSwitch
        label="chatSearchEnabled"
        value={settings.enabled}
        onChange={(enabled) => onChange({ ...settings, enabled })}
      />
      <SearchSwitch
        label="chatSearchSemantic"
        value={settings.semantic}
        onChange={(semantic) => onChange({ ...settings, semantic })}
      />
      <EmbeddingFields
        value={settings.embeddings}
        onChange={(update) => onChange({ ...settings, embeddings: { ...settings.embeddings, ...update } })}
      />
    </fieldset>
  );
}
function EmbeddingFields({
  value,
  onChange,
}: {
  value: ChatSearchSettings['embeddings'];
  onChange: (update: Partial<ChatSearchSettings['embeddings']>) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <label className="field">
        <span>{t('chatSearchSource')}</span>
        <select
          value={value.source}
          onChange={(event) =>
            onChange({
              source: event.target.value as 'local' | 'cloud',
              model: undefined,
              cloudConsent: false,
            })
          }
        >
          <option value="local">{t('chatSearchLocal')}</option>
          <option value="cloud">{t('chatSearchCloud')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('chatSearchModel')}</span>
        <input
          value={value.model ?? ''}
          placeholder={t('chatSearchAutomatic')}
          onChange={(event) => onChange({ model: event.target.value || undefined })}
        />
      </label>
      {value.source === 'cloud' && (
        <>
          <a href="#/models">{t('chatSearchKeyHelp')}</a>
          <SearchSwitch
            label="chatSearchCloudConsent"
            value={value.cloudConsent}
            onChange={(cloudConsent) => onChange({ cloudConsent })}
          />
        </>
      )}
    </>
  );
}
function SearchSwitch({
  label,
  value,
  onChange,
}: {
  label: StringKey;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="switch-field">
      <span>{t(label)}</span>
      <input
        type="checkbox"
        role="switch"
        checked={value}
        aria-checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
