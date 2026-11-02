import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Device, LiveView, ScreenFrame } from '@swiftnest/api';
import { useDevices } from './devices';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { Button } from './components/Button';

export function LiveDeviceButton() {
  const { devices } = useDevices();
  const { t } = useI18n();
  const [device, setDevice] = useState<Device>();
  const close = useCallback(() => setDevice(undefined), []);
  const available = devices.filter((d) => d.online && d.capabilities.some((c) => c.id === 'screen'));
  return (
    <>
      <div className="live-device-chips" aria-label={t('liveView')}>
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
export function LivePanel({ device, onClose }: { device: Device; onClose: () => void }) {
  const { t } = useI18n();
  const { store } = useConnection();
  const [live, setLive] = useState<LiveView>();
  const [frame, setFrame] = useState<ScreenFrame>();
  const [control, setControl] = useState<'ivy' | 'owner' | 'paused'>('paused');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [text, setText] = useState('');
  const [image, setImage] = useState('');
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const dialog = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | {
        x: number;
        y: number;
        start: number;
        moved: boolean;
        multi: boolean;
        point?: { x: number; y: number };
        frame?: ScreenFrame;
      }
    | undefined
  >(undefined);
  const gestureFrame = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (gestureFrame.current !== undefined) cancelAnimationFrame(gestureFrame.current);
    },
    [],
  );
  const previous = useRef<{ distance: number; x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    let active: LiveView | undefined;
    void (async () => {
      try {
        if (!store.client) throw new Error('offline');
        active = await store.client.openLiveView(device.device, {
          maxDimension: Math.min(2560, Math.max(640, Math.round(window.innerWidth * window.devicePixelRatio))),
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          active.close();
          return;
        }
        setLive(active);
        for await (const update of active) {
          if (controller.signal.aborted) break;
          setControl(update.control);
          setPending(false);
          if (update.frame) setFrame(update.frame);
          if (update.error) setError(`${t('liveViewFailed')} (${update.error.code})`);
        }
        if (!controller.signal.aborted) setControl('paused');
      } catch (error) {
        if (!controller.signal.aborted) {
          setControl('paused');
          setError(
            t(
              ['tls-required', 'secure-context-required'].includes((error as { code?: string }).code ?? '')
                ? 'liveTlsRequired'
                : 'liveViewFailed',
            ),
          );
        }
      }
    })();
    return () => {
      controller.abort();
      active?.close();
    };
  }, [device.device, store]);
  useEffect(() => {
    if (!frame) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(frame.image)], { type: frame.mime }));
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [frame]);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    surface.current?.focus();
    return () => {
      dialog.current?.close();
      old?.focus();
    };
  }, [onClose]);
  const send = (tool: string, args: Record<string, unknown>, source = frame) => {
    if (control !== 'owner' || !source || !live) return;
    void live
      .input(tool, { displayId: source.displayId, captureId: source.captureId, ...args })
      .catch(() => setError(t('liveInputFailed')));
  };
  const point = (x: number, y: number) => {
    const rect = picture.current?.getBoundingClientRect();
    if (!rect || !frame || x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return;
    return { x: ((x - rect.left) * frame.width) / rect.width, y: ((y - rect.top) * frame.height) / rect.height };
  };
  const down = (event: PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1)
      gesture.current = {
        x: event.clientX,
        y: event.clientY,
        start: Date.now(),
        moved: false,
        multi: false,
        point: point(event.clientX, event.clientY),
        frame,
      };
    if (pointers.current.size > 1) {
      if (gesture.current) gesture.current.multi = true;
      const [a, b] = [...pointers.current.values()];
      previous.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
    }
  };
  const move = (event: PointerEvent) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.current && Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 8)
      gesture.current.moved = true;
    if (pointers.current.size >= 2) {
      if (gestureFrame.current !== undefined) return;
      gestureFrame.current = requestAnimationFrame(() => {
        gestureFrame.current = undefined;
        const values = [...pointers.current.values()];
        if (values.length < 2) return;
        const a = values[0]!,
          b = values[1]!;
        const current = { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const prev = previous.current;
        if (prev && prev.distance > 8) {
          const ratio = current.distance / prev.distance;
          if (Math.abs(ratio - 1) > 0.015) setView((v) => ({ ...v, zoom: Math.max(1, Math.min(5, v.zoom * ratio)) }));
          else if (control === 'owner')
            send('input_scroll', { dx: (prev.x - current.x) * 2, dy: (prev.y - current.y) * 2 });
          else setView((v) => ({ ...v, x: v.x + current.x - prev.x, y: v.y + current.y - prev.y }));
        }
        previous.current = current;
      });
    } else if (control !== 'owner')
      setView((v) => ({ ...v, x: v.x + event.clientX - last.x, y: v.y + event.clientY - last.y }));
  };
  const up = (event: PointerEvent) => {
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (g && !g.multi && control === 'owner') {
      if (g.moved) {
        const to = point(event.clientX, event.clientY);
        if (g.point && to) send('input_drag', { ...g.point, toX: to.x, toY: to.y }, g.frame);
      } else if (g.point)
        send('input_click', { ...g.point, button: Date.now() - g.start >= 500 ? 'right' : 'left' }, g.frame);
    }
    if (!pointers.current.size) {
      gesture.current = undefined;
      previous.current = undefined;
    }
  };
  const take = async () => {
    if (!live) return;
    setPending(true);
    setError('');
    try {
      if (control === 'owner') await live.handBack();
      else await live.takeOver();
    } catch {
      setPending(false);
      setError(t('liveInputFailed'));
    }
  };
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
      <header className="live-header">
        <div>
          <h2>{device.name ?? device.device}</h2>
          <p role="status">{t(control === 'owner' ? 'youControl' : control === 'ivy' ? 'ivyControl' : 'livePaused')}</p>
        </div>
        <Button onClick={onClose}>{t('closeLiveView')}</Button>
      </header>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div
        ref={surface}
        tabIndex={-1}
        className="live-surface"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          pointers.current.clear();
          gesture.current = undefined;
        }}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          if (control === 'owner') send('input_scroll', { dx: event.deltaX, dy: event.deltaY });
          else setView((v) => ({ ...v, zoom: Math.max(1, Math.min(5, v.zoom - event.deltaY / 500)) }));
        }}
      >
        {image ? (
          <img
            ref={picture}
            draggable={false}
            alt={t('remoteDesktop')}
            src={image}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          />
        ) : (
          <p>{t('liveConnecting')}</p>
        )}
      </div>
      {keyboard && control === 'owner' && (
        <form
          className="live-keyboard"
          onSubmit={(event) => {
            event.preventDefault();
            if (text) {
              send('input_type', { text });
              setText('');
            }
          }}
        >
          <textarea
            autoFocus
            aria-label={t('remoteKeyboard')}
            rows={2}
            value={text}
            maxLength={4000}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" disabled={!text}>
            {t('send')}
          </Button>
          <div className="live-key-row">
            {['Return', 'BackSpace', 'Tab', 'Escape', 'ctrl+c', 'ctrl+v', 'Left', 'Right', 'Up', 'Down'].map((key) => (
              <Button key={key} type="button" onClick={() => send('input_key', { key })}>
                {key}
              </Button>
            ))}
          </div>
        </form>
      )}
      <footer className="live-footer">
        <Button onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>{t('resetView')}</Button>
        <Button disabled={control !== 'owner'} onClick={() => setKeyboard((v) => !v)}>
          {t('remoteKeyboard')}
        </Button>
        <Button variant="primary" disabled={pending || !frame || control === 'paused'} onClick={() => void take()}>
          {t(control === 'owner' ? 'handBack' : 'takeOver')}
        </Button>
      </footer>
    </dialog>
  );
}
