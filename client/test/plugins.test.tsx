import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PluginsView, PluginView } from '@swiftnest/api';
import { applyBusy, applyMessage, orderedPlugins, toggleDecision } from '../src/pluginState';
import { I18nProvider, translate } from '../src/i18n';
import { CommunityPlugins, PluginCard, PluginApplyStatus } from '../src/plugins';

export const plugin: PluginView = {
  id: 'vision',
  title: 'Cloud vision',
  summary: 'Understand images',
  note: 'Sends images to a provider.',
  enabled: false,
  recommended: false,
  active: false,
  locked: false,
  license: 'MIT',
};
const view = (apply: PluginsView['apply']): PluginsView => ({ plugins: [plugin], unaudited: [], pending: true, apply });

describe('plugin choices and apply states', () => {
  it('orders recommended choices first, preserving server order and prose', () => {
    const plugins = [plugin, { ...plugin, id: 'safe', recommended: true }, { ...plugin, id: 'other' }];
    expect(orderedPlugins(plugins).map((p) => p.id)).toEqual(['safe', 'vision', 'other']);
    expect(plugins[0]).toBe(plugin);
  });
  it('confirms only enabling a note or the community market and never changes locks', () => {
    expect(toggleDecision(plugin)).toBe('confirm');
    expect(toggleDecision({ ...plugin, enabled: true })).toBe('save');
    expect(toggleDecision({ ...plugin, note: undefined })).toBe('save');
    expect(toggleDecision({ ...plugin, id: 'market', note: undefined })).toBe('confirm');
    expect(toggleDecision({ ...plugin, locked: true })).toBe('locked');
  });
  it('keeps locked switches read-only with an explanation in both languages', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <PluginCard
            plugin={{ ...plugin, locked: true }}
            disabled={false}
            toggle={() => {
              throw new Error('locked');
            }}
          />
        </I18nProvider>,
      );
      expect(html).toContain('disabled');
      expect(html).toContain(translate(locale, 'pluginsLocked'));
      expect(html).toContain(plugin.summary);
    }
  });
  it('gives each community package its own Not reviewed label and hides an empty section', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const render = (packages: string[]) =>
        renderToStaticMarkup(
          <I18nProvider initialLocale={locale}>
            <CommunityPlugins packages={packages} />
          </I18nProvider>,
        );
      expect(render([])).toBe('');
      const html = render(['one', 'two']);
      expect(html).toContain('one');
      expect(html.split(translate(locale, 'pluginsNotReviewed'))).toHaveLength(3);
    }
  });
  it('marks installing/restarting busy and allows retries after either failure', () => {
    for (const state of ['installing', 'restarting'] as const) expect(applyBusy(view({ state }))).toBe(true);
    for (const state of ['idle', 'failed'] as const) expect(applyBusy(view({ state }))).toBe(false);
    expect(applyMessage(view({ state: 'installing' }))).toBe('pluginsPreparing');
    expect(applyMessage(view({ state: 'restarting' }))).toBe('pluginsRestarting');
    expect(applyMessage(view({ state: 'failed', rolledBack: true }))).toBe('pluginsRestored');
    expect(applyMessage(view({ state: 'failed' }))).toBeUndefined();
  });
  it('shows the exact restored message or the server-localized failure and hint', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const render = (apply: PluginsView['apply']) =>
        renderToStaticMarkup(
          <I18nProvider initialLocale={locale}>
            <PluginApplyStatus view={view(apply)} />
          </I18nProvider>,
        );
      expect(render({ state: 'failed', rolledBack: true })).toContain(
        translate(locale, 'pluginsRestored').replaceAll("'", '&#x27;'),
      );
      const error = {
        code: 'FAILED',
        message: locale === 'en' ? 'Download failed' : '下载失败',
        hint: locale === 'en' ? 'Try again' : '请重试',
      };
      expect(render({ state: 'failed', error })).toContain(error.message);
      expect(render({ state: 'failed', error })).toContain(error.hint);
    }
  });
});
