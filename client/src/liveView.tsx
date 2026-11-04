import { useCallback, useEffect, useRef, useState } from 'react';
import type { Device } from '@swiftnest/api';
import { useDevices } from './devices/hub';
import { useI18n } from './i18n';
import { Button } from './components/Button';
import { LiveHeader, LiveToolbar, LiveTools } from './devices/LiveControls';
import { useFrameImage, useLiveStream } from './devices/useLiveStream';
import { useRemoteScreen } from './devices/useRemoteScreen';

export function LiveDeviceButton() {
  const { devices } = useDevices();
  const { t } = useI18n();
  const [device, setDevice] = useState<Device>();
  const close = useCallback(() => setDevice(undefined), []);
  const available = devices.filter((d) => d.online && d.capabilities.some((c) => c.id === 'screen'));
  return (
    <>
      <div className="live-device-chips" role="toolbar" aria-label={t('liveView')}>
        {available.map((d) => (
          <Button key={d.device} onClick={() => setDevice(d)}>
            {t('liveView')} · {d.name ?? d.device}
          </Button>
        ))}
      </div>
      {device && <LivePanel device={device} onClose={close} />}
    </>
  );
}

function useLiveDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      old?.focus();
    };
  }, []);
  return dialog;
}

function RemoteScreen({
  stream,
  remote,
  phone,
}: {
  stream: ReturnType<typeof useLiveStream>;
  remote: ReturnType<typeof useRemoteScreen>;
  phone: boolean;
}) {
  const { t } = useI18n();
  const image = useFrameImage(stream.frame);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: remote screen gestures; keyboard has a separate accessible control
    <div
      ref={remote.surface}
      tabIndex={-1}
      className={`live-surface${phone ? ' live-surface--phone' : ''}`}
      onPointerDown={remote.down}
      onPointerMove={remote.move}
      onPointerUp={remote.up}
      onPointerCancel={remote.cancel}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={remote.wheel}
    >
      {image ? (
        <img
          ref={remote.picture}
          draggable={false}
          alt={t('remoteDesktop')}
          src={image}
          style={{ transform: `translate(${remote.view.x}px, ${remote.view.y}px) scale(${remote.view.zoom})` }}
        />
      ) : (
        <p role="status">{t('liveConnecting')}</p>
      )}
    </div>
  );
}

export function LivePanel({ device, onClose }: { device: Device; onClose: () => void }) {
  const { t } = useI18n();
  const stream = useLiveStream(device.device);
  const remote = useRemoteScreen(stream.frame, stream.control, stream.send);
  const dialog = useLiveDialog();
  const action = stream.live && stream.frame && stream.control !== 'paused' ? () => void stream.take() : undefined;
  return (
    <dialog
      ref={dialog}
      className="live-panel"
      onCancel={onClose}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      aria-label={`${t('liveView')} · ${device.name ?? device.device}`}
    >
      <LiveHeader name={device.name ?? device.device} control={stream.control} onClose={onClose} />
      {stream.error && (
        <p className="live-error" role="alert">
          {t(stream.error.key)}
          {stream.error.code && ` (${stream.error.code})`}
        </p>
      )}
      <div className="live-body">
        <section className="live-stage" aria-label={t('remoteDesktop')}>
          <RemoteScreen stream={stream} remote={remote} phone={device.kind === 'android'} />
          <LiveToolbar
            owner={stream.control === 'owner'}
            pending={stream.pending}
            onTakeOver={action}
            onHandBack={action}
          />
        </section>
        <aside>
          <LiveTools owner={stream.control === 'owner'} onReset={remote.reset} send={stream.send} />
        </aside>
      </div>
    </dialog>
  );
}
