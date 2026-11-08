import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelsView } from '@swiftnest/api';
import { pairingReturn } from '../src/App';
import { MediaGeminiSettings } from '../src/models';
import { ApplyStatus } from '../src/applyPanel';
import { I18nProvider, translate } from '../src/i18n';
import {
  canSaveExpert,
  keyedProviders,
  mainChoices,
  modelFor,
  providerName,
  routeFromValue,
  routesWithout,
  routeValue,
} from '../src/modelState';

const deepseek = {
  id: 'deepseek',
  name: 'DeepSeek',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  recommendedModel: 'deepseek-v4-pro',
  keyHint: 'abcd',
};
const google = {
  id: 'google',
  name: 'Google Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  recommendedModel: 'gemini-pro-latest',
};
const view: ModelsView = {
  local: { name: 'Local', model: 'ivy', contextWindow: 131072, vision: false },
  providers: [deepseek, google],
  expert: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  expertApproval: 'ask',
  geminiUploads: false,
  vision: { needed: true, readers: ['deepseek'], free: 'ask' },
  pending: false,
  apply: { state: 'idle' },
};

describe('model choices', () => {
  it('offers the local model and only providers with a key for every chat', () => {
    expect(keyedProviders(view).map((p) => p.id)).toEqual(['deepseek']);
    expect(mainChoices(view)).toEqual([
      { provider: 'local', model: 'ivy' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
    ]);
    expect(modelFor(view, google)).toBe('gemini-pro-latest');
    expect(providerName(view, 'local')).toBe('Local');
  });
  it('maps the local choice to clearing the main route', () => {
    expect(routeFromValue(routeValue({ provider: 'local', model: 'ivy' }))).toBeNull();
    const cloud = { provider: 'deepseek', model: 'deepseek-v4-pro' };
    expect(routeFromValue(routeValue(cloud))).toEqual(cloud);
  });
  it('saves an expert only with a provider, a valid model id and a saved or pasted key', () => {
    expect(canSaveExpert({ key: '', model: 'x' })).toBe(false);
    expect(canSaveExpert({ provider: deepseek, key: '', model: 'deepseek-v4-pro' })).toBe(true);
    expect(canSaveExpert({ provider: google, key: '', model: 'gemini-pro-latest' })).toBe(false);
    expect(canSaveExpert({ provider: google, key: 'short', model: 'gemini-pro-latest' })).toBe(false);
    expect(canSaveExpert({ provider: google, key: ' sk-0123456789 ', model: 'gemini-pro-latest' })).toBe(true);
    expect(canSaveExpert({ provider: google, key: 'sk-0123456789', model: 'bad model' })).toBe(false);
  });
  it('clears the routes that used a removed key', () => {
    expect(routesWithout(view, 'deepseek')).toEqual({ expert: null });
    expect(routesWithout({ ...view, main: view.expert }, 'deepseek')).toEqual({ main: null, expert: null });
    expect(routesWithout(view, 'google')).toEqual({});
  });
});

describe('model apply', () => {
  it('words a rollback for models in both languages', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <ApplyStatus
            view={{ ...view, apply: { state: 'failed', rolledBack: true } }}
            words={{ preparing: 'modelsPreparing', restored: 'modelsRestored', help: 'pluginsApplyHelp' }}
          />
        </I18nProvider>,
      );
      expect(html).toContain(translate(locale, 'modelsRestored'));
    }
  });
  it('returns to the page that asked for pairing again', () => {
    expect(pairingReturn('#/pair?return=models')).toBe('/models');
    expect(pairingReturn('#/pair?return=plugins')).toBe('/plugins');
    expect(pairingReturn('#/pair')).toBe('/');
    expect(pairingReturn('#/pair?return=unknown')).toBe('/');
    expect(pairingReturn('#/pair?url=https%3A%2F%2Fhost%2Fconnect%3Freturn%3Dplugins')).toBe('/');
  });
});

it.each(['en', 'zh-CN'] as const)('explains the default-off Google switch and key guidance in %s', (locale) => {
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MediaGeminiSettings view={view} disabled={false} save={() => {}} addKey={() => {}} />
    </I18nProvider>,
  );
  expect(html).toContain(translate(locale, 'media.gemini_uploads_switch'));
  expect(html).toContain(translate(locale, 'media.gemini_uploads_help'));
  expect(html).toContain(translate(locale, 'media.gemini_uploads_add_key'));
  expect(html).toContain('aria-checked="false"');
  expect(html).not.toContain('type="password"');
});
