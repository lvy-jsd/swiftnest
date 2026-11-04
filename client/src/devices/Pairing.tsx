import type { DevicePairing, DevicePairingCandidate } from '@swiftnest/api';
import { DeviceMobileIcon } from '@phosphor-icons/react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { useI18n } from '../i18n';

export function PairingRequest({
  candidate,
  busy,
  onAnswer,
}: {
  candidate: DevicePairingCandidate;
  busy: boolean;
  onAnswer: (accept: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Card className="device-card pairing-request" aria-label={t('confirmDevice')}>
      <header className="device-card-header">
        <DeviceMobileIcon size={32} aria-hidden="true" />
        <div>
          <h2>{candidate.device}</h2>
          <p>{t('confirmDevice')}</p>
        </div>
        <Pill dot tone="waiting">
          {t('devicesWaiting')}
        </Pill>
      </header>
      {/* Candidates expose a fingerprint, not the six-digit invitation code. Never shorten it into a fake code. */}
      <p>{t('compareFingerprints')}</p>
      <code className="pairing-fingerprint">{candidate.fingerprint}</code>
      <div className="device-actions">
        <Button variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
          {t('devicesAllowPairing')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onAnswer(false)}>
          {t('deny')}
        </Button>
      </div>
    </Card>
  );
}

export function PairingInvitation({ pairing, now }: { pairing: DevicePairing; now: number }) {
  const { t, locale } = useI18n();
  const active = Date.parse(pairing.expiresAt) > now;
  return (
    <Card className="device-card pairing-request" aria-label={t('pairDevice')}>
      <h2>{t(active ? 'pairingCode' : 'pairingExpired')}</h2>
      {active && (
        <>
          <output className="pairing-code">{pairing.code}</output>
          <p>
            {t('expires')}: {new Date(pairing.expiresAt).toLocaleTimeString(locale)}
          </p>
        </>
      )}
      <p>
        {t('dialAddress')}: <code>{pairing.url}</code>
      </p>
      <p>
        {t('nestFingerprint')}: <code>{pairing.fingerprint}</code>
      </p>
      <p>{t('compareFingerprints')}</p>
    </Card>
  );
}
