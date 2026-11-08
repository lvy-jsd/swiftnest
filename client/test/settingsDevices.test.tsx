import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Device } from '@swiftnest/api';
import { DeviceSettingsList } from '../src/settingsDevices';
import { I18nProvider, translate, type Locale } from '../src/i18n';

const phone: Device = {
  device: 'phone',
  name: 'My phone',
  kind: 'android',
  online: true,
  paired: true,
  fingerprint: 'aaaa-bbbb-cccc-dddd',
  capabilities: [],
};
const laptop: Device = {
  device: 'laptop',
  kind: 'desktop',
  online: false,
  paired: true,
  fingerprint: 'eeee-ffff-0000-1111',
  capabilities: [],
};

function render(devices: Device[], locale: Locale = 'en') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <DeviceSettingsList devices={devices} busy={false} onRevoke={() => {}} />
    </I18nProvider>,
  );
}

describe('settings device list', () => {
  it('lists every device with its kind and live state', () => {
    const html = render([phone, laptop]);
    expect(html).toContain('My phone');
    expect(html).toContain(translate('en', 'devicesPhone'));
    expect(html).toContain(translate('en', 'devicesComputer'));
    expect(html).toContain('pill--success');
    expect(html).toContain('pill--neutral');
  });

  it('falls back to the device id when it has no name', () => {
    expect(render([laptop])).toContain('laptop');
  });

  it('offers one revoke action per device and nothing else that could cut a device off', () => {
    const html = render([phone, laptop]);
    expect((html.match(/button--ghost/g) ?? []).length).toBe(2);
    expect(html).toContain(translate('en', 'revokeDevice'));
    expect(html).not.toContain('button--danger');
  });

  it('disables revoking while a request is already in flight', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DeviceSettingsList devices={[phone]} busy onRevoke={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('disabled');
  });
});
