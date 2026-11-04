/**
 * The owner's model page: the local model stays the default, and a beginner can add a
 * stronger cloud model for hard tasks with their own API key. Picking a cloud model for
 * every chat and editing model ids sit under advanced options.
 */
import { useState } from 'react';
import type { ModelProviderView, ModelSettingsUpdate, ModelsView, SwiftnestClient } from '@swiftnest/api';
import { ApplyPanel, type ApplyWords } from './applyPanel';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import {
  canSaveExpert,
  keyedProviders,
  mainChoices,
  modelFor,
  providerName,
  routeFromValue,
  routesWithout,
  routeValue,
  type ExpertDraft,
} from './modelState';
import { useOwnerResource, type OwnerSource } from './ownerResource';
import { applyBusy } from './pluginState';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { HubPage, SheetPage } from './components/pages';

const source: OwnerSource<ModelsView> = { read: (client) => client.listModels(), event: 'models-changed' };
const words: ApplyWords = { preparing: 'modelsPreparing', restored: 'modelsRestored', help: 'pluginsApplyHelp' };

type Save = (action: (client: SwiftnestClient) => Promise<ModelsView>) => Promise<boolean>;

function LocalModel({ view }: { view: ModelsView }) {
  const { t, locale } = useI18n();
  const context = new Intl.NumberFormat(locale, { notation: 'compact' }).format(view.local.contextWindow);
  return (
    <Card className="plugin-card">
      <h2>{t('modelsLocal')}</h2>
      <p>{view.local.model}</p>
      <p className="plugin-muted">{t('modelsLocalHelp')}</p>
      <p className="plugin-muted">
        {t('modelsContext')}: {context}
      </p>
    </Card>
  );
}

/** How photos reach a main model that cannot see, and the switch for the free service. */
function Photos({
  view,
  disabled,
  save,
}: {
  view: ModelsView;
  disabled: boolean;
  save: (update: ModelSettingsUpdate) => void;
}) {
  const { t } = useI18n();
  const { needed, readers, free } = view.vision;
  const names = readers.map((id) => providerName(view, id)).join(', ');
  const on = free === 'on';
  return (
    <Card className="plugin-card">
      <h2>{t('visionTitle')}</h2>
      <p className="plugin-muted">
        {!needed
          ? t('visionSees')
          : readers.length
            ? `${t('visionReaders')} ${names}`
            : t(on ? 'visionFree' : 'visionNone')}
      </p>
      {needed && (
        <div className="plugin-card__row">
          <div>
            <p className="model-label" id="models-free-vision">
              {t('visionFreeSwitch')}
            </p>
            <p className="plugin-muted">{t('visionFreeHelp')}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-labelledby="models-free-vision"
            checked={on}
            aria-checked={on}
            disabled={disabled}
            onChange={() => save({ freeVision: on ? 'off' : 'on' })}
          />
        </div>
      )}
    </Card>
  );
}

function Expert({
  view,
  disabled,
  choose,
  save,
}: {
  view: ModelsView;
  disabled: boolean;
  choose: () => void;
  save: (update: ModelSettingsUpdate) => void;
}) {
  const { t } = useI18n();
  const { expert } = view;
  const ask = view.expertApproval === 'ask';
  return (
    <Card className="plugin-card">
      <h2>{t('modelsExpert')}</h2>
      <p>{expert ? `${providerName(view, expert.provider)} · ${expert.model}` : t('modelsExpertNone')}</p>
      <p className="plugin-muted">{t('modelsExpertHelp')}</p>
      <div className="model-actions">
        <Button variant={expert ? 'soft' : 'primary'} disabled={disabled} onClick={choose}>
          {t(expert ? 'modelsExpertChange' : 'modelsExpertAdd')}
        </Button>
        {expert && (
          <Button variant="ghost" disabled={disabled} onClick={() => save({ expert: null })}>
            {t('modelsExpertRemove')}
          </Button>
        )}
      </div>
      {expert && (
        <div className="plugin-card__row">
          <div>
            <p className="model-label" id="models-ask-first">
              {t('modelsAskFirst')}
            </p>
            <p className="plugin-muted">{t('modelsAskFirstHelp')}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-labelledby="models-ask-first"
            checked={ask}
            aria-checked={ask}
            disabled={disabled}
            onChange={() => save({ expertApproval: ask ? 'auto' : 'ask' })}
          />
        </div>
      )}
    </Card>
  );
}

function CloudKeys({
  view,
  disabled,
  remove,
}: {
  view: ModelsView;
  disabled: boolean;
  remove: (provider: ModelProviderView) => void;
}) {
  const { t } = useI18n();
  const keyed = keyedProviders(view);
  if (!keyed.length) return null;
  return (
    <section aria-label={t('modelsKeys')}>
      <h2>{t('modelsKeys')}</h2>
      {keyed.map((provider) => (
        <Card className="plugin-card plugin-card__row" key={provider.id}>
          <div>
            <p className="model-label">{provider.name}</p>
            <p className="plugin-muted">
              {t('modelsKeySaved')} {provider.keyHint}
            </p>
          </div>
          <Button variant="ghost" disabled={disabled} onClick={() => remove(provider)}>
            {t('modelsKeyRemove')}
          </Button>
        </Card>
      ))}
    </section>
  );
}

function MainModel({
  view,
  disabled,
  save,
}: {
  view: ModelsView;
  disabled: boolean;
  save: (update: ModelSettingsUpdate) => void;
}) {
  const { t } = useI18n();
  const current = view.main ?? mainChoices(view)[0]!;
  return (
    <details className="plugin-card">
      <summary>{t('modelsAdvanced')}</summary>
      <label className="model-field">
        <span className="model-label">{t('modelsMain')}</span>
        <span className="plugin-muted">{t('modelsMainHelp')}</span>
        <select
          value={routeValue(current)}
          disabled={disabled}
          onChange={(event) => save({ main: routeFromValue(event.target.value) })}
        >
          {mainChoices(view).map((route) => (
            <option key={routeValue(route)} value={routeValue(route)}>
              {providerName(view, route.provider)} · {route.model}
            </option>
          ))}
        </select>
      </label>
    </details>
  );
}

function ProviderChoice({
  view,
  draft,
  pick,
}: {
  view: ModelsView;
  draft: ExpertDraft;
  pick: (provider: ModelProviderView) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="model-providers">
      <legend>{t('modelsChooseProvider')}</legend>
      {view.providers.map((provider) => (
        <label key={provider.id} className="model-provider">
          <input
            type="radio"
            name="model-provider"
            checked={draft.provider?.id === provider.id}
            onChange={() => pick(provider)}
          />
          {provider.name}
        </label>
      ))}
    </fieldset>
  );
}

function ProviderKey({
  draft,
  update,
  keyOnly = false,
}: {
  draft: ExpertDraft;
  update: (draft: ExpertDraft) => void;
  keyOnly?: boolean;
}) {
  const { t } = useI18n();
  const { provider } = draft;
  if (!provider) return null;
  return (
    <>
      <a href={provider.keyUrl} target="_blank" rel="noreferrer">
        {t('modelsGetKey')}
      </a>
      {provider.keyHint && (
        <p className="plugin-muted">
          {t('modelsKeySaved')} {provider.keyHint}
        </p>
      )}
      <label className="model-field">
        <span className="model-label">{t('modelsKey')}</span>
        <input
          type="password"
          autoComplete="off"
          value={draft.key}
          onChange={(event) => update({ ...draft, key: event.target.value })}
        />
      </label>
      <p className="plugin-muted">{t('modelsKeyHelp')}</p>
      {!keyOnly && (
        <details>
          <summary>{t('modelsAdvanced')}</summary>
          <label className="model-field">
            <span className="model-label">{t('modelsModelId')}</span>
            <input value={draft.model} onChange={(event) => update({ ...draft, model: event.target.value })} />
          </label>
        </details>
      )}
    </>
  );
}

function ExpertSheet({
  view,
  open,
  disabled,
  close,
  save,
  keyOnly,
}: {
  view: ModelsView;
  open: boolean;
  keyOnly?: ModelProviderView;
  disabled: boolean;
  close: () => void;
  save: (draft: ExpertDraft) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ExpertDraft>({
    provider: keyOnly,
    key: '',
    model: keyOnly?.recommendedModel ?? '',
  });
  const pick = (provider: ModelProviderView) => setDraft({ provider, key: '', model: modelFor(view, provider) });
  return (
    <SheetPage
      open={open}
      title={t(keyOnly ? 'media.gemini_uploads_add_key' : 'modelsExpert')}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>{t('pluginsCancel')}</Button>
          <Button variant="primary" disabled={disabled || !canSaveExpert(draft)} onClick={() => void save(draft)}>
            {t('modelsSave')}
          </Button>
        </>
      }
    >
      <p>{t(keyOnly ? 'media.gemini_uploads_key_required' : 'modelsExpertHelp')}</p>
      {!keyOnly && <ProviderChoice view={view} draft={draft} pick={pick} />}
      <ProviderKey draft={draft} update={setDraft} keyOnly={!!keyOnly} />
    </SheetPage>
  );
}

function saveExpert(client: SwiftnestClient, { provider, key, model }: ExpertDraft): Promise<ModelsView> {
  const id = provider!.id;
  const saveKey = key.trim() ? client.setModelKey(id, key.trim()) : Promise.resolve();
  return saveKey.then(() => client.updateModels({ expert: { provider: id, model: model.trim() } }));
}

export function MediaGeminiSettings({
  view,
  disabled,
  save,
  addKey,
}: {
  view: ModelsView;
  disabled: boolean;
  save: (update: ModelSettingsUpdate) => void;
  addKey: () => void;
}) {
  const { t } = useI18n();
  const hasKey = !!view.providers.find((provider) => provider.id === 'google')?.keyHint;
  const enabled = view.geminiUploads && hasKey;
  return (
    <Card className="plugin-card">
      <h2>{t('media.gemini_uploads_title')}</h2>
      <label className="model-field">
        <span className="model-label">{t('media.gemini_uploads_switch')}</span>
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          aria-checked={enabled}
          disabled={disabled}
          aria-describedby="media-gemini-help"
          onChange={() => (hasKey ? save({ geminiUploads: !enabled }) : addKey())}
        />
      </label>
      <p className="plugin-muted" id="media-gemini-help">
        {t('media.gemini_uploads_help')}
      </p>
      {!hasKey && (
        <>
          <p className="plugin-muted">{t('media.gemini_uploads_key_required')}</p>
          <Button disabled={disabled} onClick={addKey}>
            {t('media.gemini_uploads_add_key')}
          </Button>
        </>
      )}
      <p className="plugin-muted">{t('media.gemini_uploads_apply')}</p>
    </Card>
  );
}

function ModelSettings({ view, disabled, act }: { view: ModelsView; disabled: boolean; act: Save }) {
  const [choosing, setChoosing] = useState<'expert' | 'google' | undefined>();
  const save = (update: ModelSettingsUpdate) => void act((client) => client.updateModels(update));
  const remove = (provider: ModelProviderView) =>
    void act(async (client) => {
      await client.setModelKey(provider.id, '');
      return client.updateModels(routesWithout(view, provider.id));
    });
  const addExpert = async (draft: ExpertDraft) => {
    const action = (client: SwiftnestClient) =>
      choosing === 'google' ? client.setModelKey('google', draft.key.trim()) : saveExpert(client, draft);
    if (await act(action)) setChoosing(undefined);
  };
  return (
    <>
      <LocalModel view={view} />
      <Photos view={view} disabled={disabled} save={save} />
      <Expert view={view} disabled={disabled} choose={() => setChoosing('expert')} save={save} />
      <MediaGeminiSettings view={view} disabled={disabled} save={save} addKey={() => setChoosing('google')} />
      <CloudKeys view={view} disabled={disabled} remove={remove} />
      <MainModel view={view} disabled={disabled} save={save} />
      {choosing && (
        <ExpertSheet
          view={view}
          open
          disabled={disabled}
          close={() => setChoosing(undefined)}
          save={addExpert}
          keyOnly={choosing === 'google' ? view.providers.find((provider) => provider.id === 'google') : undefined}
        />
      )}
    </>
  );
}

export function ModelsPage({ onBack }: { onBack: () => void }) {
  const { view, owner, busy, failed, act } = useOwnerResource(source);
  const { store, status } = useConnection();
  const { t } = useI18n();
  const disabled = busy || applyBusy(view) || status !== 'connected';
  const actWith: Save = (action) => act(() => action(store.client!));
  return (
    <HubPage title={t('modelsTitle')} subtitle={t('modelsHelp')} onBack={onBack}>
      {owner && view ? (
        <>
          <ApplyPanel
            view={view}
            words={words}
            busy={busy}
            page="models"
            apply={() => void act(() => store.client!.applyModels())}
          />
          {failed && status === 'connected' && <p role="alert">{t('pluginsRequestFailed')}</p>}
          <ModelSettings view={view} disabled={disabled} act={actWith} />
        </>
      ) : (
        <p role="status">{t(failed ? 'pluginsOwnerOnly' : 'modelsLoading')}</p>
      )}
    </HubPage>
  );
}
