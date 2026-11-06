import { useState } from 'react';
import type { McpPresetView, ToolsView } from '@swiftnest/api';
import { ApplyPanel, type ApplyWords } from './applyPanel';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { useConnection } from './connection';
import { useI18n, type StringKey } from './i18n';
import type { OwnerResource, OwnerSource } from './ownerResource';

export const toolsSource: OwnerSource<ToolsView> = { read: (client) => client.listTools(), event: 'tools-changed' };
export const toolApplyWords: ApplyWords = {
  preparing: 'toolsPreparing',
  restored: 'toolsRestored',
  help: 'toolsApplyHelp',
  restarting: 'toolsRestarting',
};

/** The preset categories Tool Ultra ships, with a readable name for each. */
const CATEGORY_WORDS = {
  memory: 'toolsCategoryMemory',
  automation: 'toolsCategoryAutomation',
  code: 'toolsCategoryCode',
  browser: 'toolsCategoryBrowser',
  system: 'toolsCategorySystem',
  search: 'toolsCategorySearch',
  collaboration: 'toolsCategoryCollaboration',
  maps: 'toolsCategoryMaps',
} as const satisfies Record<string, StringKey>;

function categoryName(t: (key: StringKey) => string, category: string): string {
  const word = (CATEGORY_WORDS as Record<string, StringKey | undefined>)[category];
  return word ? t(word) : category;
}

export function McpPresetRow({
  preset,
  disabled,
  toggle,
}: {
  preset: McpPresetView;
  disabled: boolean;
  toggle(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="tool-preset">
      <div className="plugin-card__row">
        <div>
          <h3>{preset.title}</h3>
          <p>{preset.summary}</p>
          <p className="plugin-muted">
            {categoryName(t, preset.category)} · {preset.source}
          </p>
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-label={preset.title}
          checked={preset.enabled}
          aria-checked={preset.enabled}
          disabled={disabled}
          onChange={toggle}
          aria-describedby={preset.state === 'needs-key' ? `tool-needs-${preset.id}` : undefined}
        />
      </div>
      {preset.state === 'needs-key' && (
        <div id={`tool-needs-${preset.id}`} className="tool-needs">
          <p>{t('toolsMissing')}</p>
          <ul>
            {preset.needs.map((need) => (
              <li key={need.env}>
                <code>{need.env}</code> — {need.hint}
              </li>
            ))}
          </ul>
          <p>{t('toolsKeyHelp')}</p>
        </div>
      )}
    </div>
  );
}

export function ToolsSection({ resource, disabled }: { resource: OwnerResource<ToolsView>; disabled: boolean }) {
  const { view, busy, failed, act } = resource;
  const { store, status } = useConnection();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [targets, setTargets] = useState('');
  return (
    <section className="tools-section" aria-labelledby="tools-title">
      <div>
        <h2 id="tools-title">{t('toolsTitle')}</h2>
        <p>{t('toolsHelp')}</p>
      </div>
      {failed && <p role="alert">{t('toolsRequestFailed')}</p>}
      {!view ? (
        <p role="status">{t('toolsLoading')}</p>
      ) : (
        <>
          <ApplyPanel
            view={view}
            words={toolApplyWords}
            busy={busy || disabled}
            page="plugins"
            apply={() => void act(() => store.client!.applyTools())}
          />
          <Card className="plugin-card tool-group">
            <h2>{t('toolsMcpTitle')}</h2>
            <p>{t('toolsMcpHelp')}</p>
            {!view.presets.length && <p role="status">{t('toolsMcpEmpty')}</p>}
            {view.presets.map((preset) => (
              <McpPresetRow
                key={preset.id}
                preset={preset}
                disabled={disabled}
                toggle={() => void act(() => store.client!.setMcpPresetEnabled(preset.id, !preset.enabled))}
              />
            ))}
          </Card>
          <Card className="plugin-card tool-group">
            <h2>{t('toolsPacksTitle')}</h2>
            <p>{t('toolsPacksHelp')}</p>
            {!view.packs.length && <p className="plugin-muted">{t('toolsPacksEmpty')}</p>}
            {view.packs.map((pack) => (
              <div className="tool-pack" key={pack.name}>
                <div>
                  <h3>{pack.name}</h3>
                  <p>{pack.targets.join(', ')}</p>
                </div>
                <Button
                  disabled={disabled}
                  aria-label={t('toolsDeletePack').replace('{name}', pack.name)}
                  onClick={() => void act(() => store.client!.deleteCapabilityPack(pack.name))}
                >
                  {t('toolsDelete')}
                </Button>
              </div>
            ))}
            <form
              className="memory-form tool-pack-form"
              onSubmit={(event) => {
                event.preventDefault();
                const values = targets
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean);
                void act(() => store.client!.setCapabilityPack(name, values)).then((saved) => {
                  if (saved) {
                    setName('');
                    setTargets('');
                  }
                });
              }}
            >
              <label>
                {t('toolsPackName')}
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  pattern="[a-z0-9][a-z0-9-]{0,47}"
                  maxLength={48}
                  disabled={disabled}
                  aria-describedby="tools-pack-name-help"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <p id="tools-pack-name-help" className="plugin-muted">
                {t('toolsPackNameHelp')}
              </p>
              <label>
                {t('toolsPackTargets')}
                <textarea
                  value={targets}
                  onChange={(event) => setTargets(event.target.value)}
                  required
                  rows={3}
                  disabled={disabled}
                  aria-describedby="tools-pack-targets-help"
                  spellCheck={false}
                />
              </label>
              <p id="tools-pack-targets-help" className="plugin-muted">
                {t('toolsPackTargetsHelp')}
              </p>
              <Button type="submit" disabled={disabled || status !== 'connected' || !name || !targets.trim()}>
                {t('toolsAddPack')}
              </Button>
            </form>
          </Card>
        </>
      )}
    </section>
  );
}
