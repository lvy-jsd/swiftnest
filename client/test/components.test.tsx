import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/Button';
import { IconButton } from '../src/components/IconButton';
import { Chip } from '../src/components/Chip';
import { Pill } from '../src/components/Pill';
import { ListRow } from '../src/components/ListRow';
import { Card } from '../src/components/Card';
import { Sheet } from '../src/components/Sheet';
import { I18nProvider, translate } from '../src/i18n';

const label = translate('zh-CN', 'appearance');

describe('晨巢 base components', () => {
  it.each(['primary', 'soft', 'ghost', 'danger'] as const)(
    'renders the %s Button with safe form defaults',
    (variant) => {
      const html = renderToStaticMarkup(
        <Button variant={variant} disabled>
          {label}
        </Button>,
      );
      expect(html).toContain(`button--${variant}`);
      expect(html).toContain('type="button"');
      expect(html).toContain('disabled=""');
      expect(html).toContain(label);
    },
  );
  it('keeps icon buttons named and decorative icons out of the accessible name', () => {
    const html = renderToStaticMarkup(
      <IconButton aria-label={label}>
        <svg />
      </IconButton>,
    );
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('icon-button');
    expect(html).toContain('aria-hidden="true"');
  });
  it.each([true, false])('exposes Chip selection %s', (selected) => {
    const html = renderToStaticMarkup(<Chip selected={selected}>{label}</Chip>);
    expect(html).toContain(`aria-pressed="${selected}"`);
    expect(html).toContain('type="button"');
  });
  it('renders status pills with optional decorative dots', () => {
    for (const tone of ['neutral', 'success', 'waiting', 'danger', 'accent'] as const) {
      const html = renderToStaticMarkup(
        <Pill tone={tone} dot>
          {label}
        </Pill>,
      );
      expect(html).toContain(`pill--${tone}`);
      expect(html).toContain('aria-hidden="true"');
    }
    expect(renderToStaticMarkup(<Pill>{label}</Pill>)).not.toContain('pill__dot');
  });
  it('uses a native button only for actionable ListRows and includes the complete content', () => {
    const content = { title: label, subtitle: translate('zh-CN', 'accent'), value: translate('zh-CN', 'iris') };
    const html = renderToStaticMarkup(<ListRow {...content} icon={<svg />} chevron onClick={() => {}} />);
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    for (const text of Object.values(content)) expect(html).toContain(text);
    expect(html).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<ListRow {...content} />)).toMatch(/^<div/);
    expect(renderToStaticMarkup(<ListRow {...content} />)).not.toContain('<button');
  });
  it('renders cards and native sheets without the translucent glass class', () => {
    expect(renderToStaticMarkup(<Card>{label}</Card>)).toContain('class="card ');
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Sheet open onClose={() => {}} title={label}>
          {label}
        </Sheet>
      </I18nProvider>,
    );
    expect(html).toContain('<dialog');
    expect(html).toContain('class="sheet"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).not.toContain('glass');
  });
});
