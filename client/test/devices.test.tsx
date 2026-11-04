import type { ReactElement } from 'react';
import type { Device } from '@swiftnest/api';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeviceCard } from '../src/devices/DeviceCard';
import { relativeLastSeen } from '../src/devices/relativeLastSeen';
import { PairingInvitation, PairingRequest } from '../src/devices/Pairing';
import { LiveToolbar } from '../src/devices/LiveControls';
import { I18nProvider, translate, type Locale } from '../src/i18n';

const now = Date.parse('2026-11-04T08:00:00Z');
const device: Device = {
  device: 'phone',
  name: 'My phone',
  kind: 'android',
  online: true,
  paired: true,
  fingerprint: 'aaaa-bbbb-cccc-dddd',
  capabilities: [{ id: 'screen', version: '1', tools: ['capture'] }],
};
function render(element: ReactElement, locale: Locale = 'zh-CN') {
  return renderToStaticMarkup(<I18nProvider initialLocale={locale}>{element}</I18nProvider>);
}
function card(value = device, locale: Locale = 'zh-CN') {
  return render(<DeviceCard device={value} now={now} busy={false} onOpen={() => {}} onRevoke={() => {}} />, locale);
}

describe('device cards', () => {
  it('shows an online phone with a quiet placeholder and its backed screen action', () => {
    const html = card();
    expect(html).toContain('pill--success');
    expect(html).toContain('pill__dot');
    expect(html).toContain('device-preview--phone');
    expect(html).toContain(translate('zh-CN', 'devicesViewScreen'));
    expect(html).toContain('button--primary');
    expect(html).not.toContain('<img');
  });
  it('hides viewing for a phone without screen capability', () => {
    expect(card({ ...device, capabilities: [] })).not.toContain(translate('zh-CN', 'devicesViewScreen'));
  });
  it.each([undefined, { cpu: 23, memory: 28, disk: 58 }])(
    'does not invent telemetry from unsupported stats %j',
    (stats) => {
      // Device currently has no telemetry contract, even if an extra field arrives in a payload.
      const computer = { ...device, kind: 'desktop' as const, stats, capabilities: [] };
      const html = card(computer);
      expect(html).toContain(translate('zh-CN', 'devicesComputer'));
      expect(html).not.toContain('device-preview--phone');
      expect(html).not.toContain('<progress');
      expect(html).not.toContain('23%');
    },
  );
  it.each(['zh-CN', 'en'] as const)('shows offline last seen in %s and hides its screen action', (locale) => {
    const html = card({ ...device, online: false, lastSeen: '2026-11-04T06:00:00Z' }, locale);
    expect(html).toContain('device-tile--offline');
    expect(html).toContain('pill--neutral');
    expect(html).toContain(translate(locale, 'devicesLastOnline'));
    expect(html).toContain(relativeLastSeen('2026-11-04T06:00:00Z', locale, now));
    expect(html).not.toContain(translate(locale, 'devicesViewScreen'));
  });
  it('omits last seen when missing or invalid and clamps future dates to now', () => {
    expect(card({ ...device, online: false })).not.toContain('<time');
    expect(card({ ...device, online: false, lastSeen: 'invalid' })).not.toContain('<time');
    expect(relativeLastSeen('2026-11-04T09:00:00Z', 'en', now)).toBe('now');
  });
});

describe('pairing cards', () => {
  it('shows the real fingerprint and both confirmation actions, without manufacturing a code', () => {
    const html = render(
      <PairingRequest
        candidate={{ id: 'candidate', device: 'Tablet', fingerprint: device.fingerprint }}
        busy
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain('pairing-request');
    expect(html).toContain('pill--waiting');
    expect(html).toContain(device.fingerprint);
    expect(html).toContain(translate('zh-CN', 'devicesAllowPairing'));
    expect(html).toContain('button--ghost');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('<output');
  });
  it('shows the six-digit invitation code only while it is valid', () => {
    const pairing = {
      code: '482913',
      expiresAt: '2026-11-04T08:01:00Z',
      address: 'localhost',
      port: 7711,
      url: 'ws://localhost:7711',
      fingerprint: device.fingerprint,
    };
    expect(render(<PairingInvitation pairing={pairing} now={now} />)).toContain('>482913</output>');
    expect(render(<PairingInvitation pairing={pairing} now={now + 61_000} />)).not.toContain('482913');
  });
});

it('live toolbar exposes only backed actions and uses the correct ownership action', () => {
  expect(render(<LiveToolbar owner={false} pending={false} />)).toBe('');
  const html = render(<LiveToolbar owner={false} pending onTakeOver={() => {}} />);
  expect(html).toContain(translate('zh-CN', 'liveTakeOver'));
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('停止任务');
  expect(html).not.toContain('暂停');
  expect(render(<LiveToolbar owner pending={false} onTakeOver={() => {}} />)).toBe('');
  expect(render(<LiveToolbar owner pending={false} onHandBack={() => {}} />)).toContain(translate('zh-CN', 'handBack'));
});
