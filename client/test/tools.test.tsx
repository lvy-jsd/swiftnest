import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { McpPresetView, ToolsView } from '@swiftnest/api';
import { ConnectionProvider, ConnectionStore } from '../src/connection';
import { I18nProvider, translate } from '../src/i18n';
import { McpPresetRow, ToolsSection, toolApplyWords } from '../src/tools';
import { ApplyStatus } from '../src/applyPanel';

const preset: McpPresetView = {
  id: 'fixture',
  title: 'Fixture title',
  summary: 'One-line description',
  category: 'test',
  source: 'test-package',
  license: 'MIT',
  enabled: false,
  state: 'off',
  needs: [],
};
describe('tool settings UI', () => {
  it.each(['en', 'zh-CN'] as const)(
    'labels switches by title, starts off and explains missing settings in %s',
    (locale) => {
      const render = (value: McpPresetView) =>
        renderToStaticMarkup(
          <I18nProvider initialLocale={locale}>
            <McpPresetRow preset={value} disabled={false} toggle={vi.fn()} />
          </I18nProvider>,
        );
      const off = render(preset);
      expect(off).toContain('role="switch"');
      expect(off).toContain('aria-label="Fixture title"');
      expect(off).toContain('aria-checked="false"');
      expect(off).not.toContain('checked=""');
      expect(off).toContain(preset.summary);
      expect(off).toContain(preset.source);
      const waiting = render({
        ...preset,
        enabled: true,
        state: 'needs-key',
        needs: [{ env: 'TEST_KEY', hint: 'Get it at https://example.test/keys' }],
      });
      expect(waiting).toContain('aria-checked="true"');
      expect(waiting).toContain('aria-describedby="tool-needs-fixture"');
      expect(waiting).toContain('TEST_KEY');
      expect(waiting).toContain('https://example.test/keys');
      expect(waiting).toContain(translate(locale, 'toolsMissing'));
      expect(waiting).toContain(translate(locale, 'toolsKeyHelp'));
    },
  );
  it.each(['en', 'zh-CN'] as const)(
    'lists named targets, labelled creation/deletion controls and shared rollback status in %s',
    (locale) => {
      const view: ToolsView = {
        presets: [],
        packs: [{ name: 'research', targets: ['pack:web', 'device:current'] }],
        pending: false,
        apply: { state: 'idle' },
      };
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <ConnectionProvider store={new ConnectionStore()}>
            <ToolsSection disabled resource={{ view, owner: true, busy: false, failed: false, act: vi.fn() }} />
          </ConnectionProvider>
        </I18nProvider>,
      );
      for (const key of ['toolsMcpEmpty', 'toolsPackName', 'toolsPackTargets', 'toolsAddPack'] as const)
        expect(html).toContain(translate(locale, key));
      expect(html).toContain('pack:web, device:current');
      expect(html).toContain(translate(locale, 'toolsDeletePack').replace('{name}', 'research'));
      expect(html).toContain('pattern="[a-z0-9][a-z0-9-]{0,47}"');
      const status = renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <ApplyStatus view={{ ...view, apply: { state: 'failed', rolledBack: true } }} words={toolApplyWords} />
        </I18nProvider>,
      );
      expect(status).toContain(translate(locale, 'toolsRestored'));
    },
  );
  it('names a known category in the reader language and keeps an unknown one as it is', () => {
    const render = (category: string) =>
      renderToStaticMarkup(
        <I18nProvider initialLocale="zh-CN">
          <McpPresetRow preset={{ ...preset, category }} disabled={false} toggle={vi.fn()} />
        </I18nProvider>,
      );
    expect(render('memory')).toContain(translate('zh-CN', 'toolsCategoryMemory'));
    expect(render('browser')).toContain(translate('zh-CN', 'toolsCategoryBrowser'));
    // An unknown category stays readable instead of showing a blank line.
    expect(render('test')).toContain('test');
  });
  it('keeps the apply action reachable while the plugin page has its own pending change', () => {
    const view: ToolsView = {
      presets: [],
      packs: [],
      pending: true,
      apply: { state: 'idle' },
    };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ConnectionProvider store={new ConnectionStore()}>
          <ToolsSection disabled resource={{ view, owner: true, busy: false, failed: false, act: vi.fn() }} />
        </ConnectionProvider>
      </I18nProvider>,
    );
    // The tool changes need their own apply button, or a saved switch never
    // reaches the kernel while the plugin page is waiting for an apply.
    expect(html).toContain(translate('en', 'toolsApplyHelp'));
  });
});
