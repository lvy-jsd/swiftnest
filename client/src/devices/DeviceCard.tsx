import { DesktopIcon, DeviceMobileIcon, EyeIcon } from '@phosphor-icons/react';
import type { Device } from '@swiftnest/api';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { useI18n } from '../i18n';
import { relativeLastSeen } from './relativeLastSeen';
import { SendFile } from '../transfers';

type CardProps = {
  device: Device;
  now: number;
  busy: boolean;
  onOpen: () => void;
  onRevoke: () => void;
};

function DeviceDetails({ device }: { device: Device }) {
  const { t } = useI18n();
  return (
    <details className="device-details">
      <summary>{t('devicesDetails')}</summary>
      <p>
        {t('deviceFingerprint')}: <code>{device.fingerprint}</code>
      </p>
      <p>
        {t('capabilities')}:{' '}
        {device.capabilities.map((capability) => `${capability.id} (${capability.tools.join(', ')})`).join(' · ') ||
          t('none')}
      </p>
    </details>
  );
}

export function DeviceCard({ device, now, busy, onOpen, onRevoke }: CardProps) {
  const { t, locale } = useI18n();
  const phone = device.kind === 'android';
  const Icon = phone ? DeviceMobileIcon : DesktopIcon;
  const screen = device.online && device.capabilities.some((capability) => capability.id === 'screen');
  const lastSeen = !device.online && device.lastSeen ? relativeLastSeen(device.lastSeen, locale, now) : undefined;
  return (
    <Card className={`device-card device-tile${device.online ? '' : ' device-tile--offline'}`}>
      <header className="device-card-header">
        <div>
          <h2>{device.name ?? device.device}</h2>
          <p>{device.kind ? t(phone ? 'devicesPhone' : 'devicesComputer') : device.via}</p>
        </div>
        <Pill dot tone={device.online ? 'success' : 'neutral'}>
          {t(device.online ? 'online' : 'offline')}
        </Pill>
      </header>
      <div className={`device-preview${phone ? ' device-preview--phone' : ''}`}>
        <Icon size={56} weight="light" aria-hidden="true" />
        {lastSeen ? (
          <p>
            {t('devicesLastOnline')} <time dateTime={device.lastSeen}>{lastSeen}</time>
          </p>
        ) : (
          <p>{t('devicesScreenPlaceholder')}</p>
        )}
      </div>
      {device.via && device.kind && <p className="device-route">{device.via}</p>}
      <div className="device-actions">
        {screen && (
          <Button variant="primary" onClick={onOpen}>
            <EyeIcon size={20} aria-hidden="true" />
            {t('devicesViewScreen')}
          </Button>
        )}
        {device.online && device.slug && device.capabilities.some((capability) => capability.id === 'files') && (
          <SendFile source={device.slug} />
        )}
        <Button variant="ghost" disabled={busy} onClick={onRevoke}>
          {t('revokeDevice')}
        </Button>
      </div>
      <DeviceDetails device={device} />
    </Card>
  );
}
