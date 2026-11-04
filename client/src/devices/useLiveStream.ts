import { useEffect, useState } from 'react';
import type { LiveView, LiveUpdate, ScreenFrame } from '@swiftnest/api';
import { useConnection } from '../connection';
import type { StringKey } from '../i18n';

async function receiveLive(live: LiveView, signal: AbortSignal, update: (value: LiveUpdate) => void) {
  for await (const value of live) {
    if (signal.aborted) break;
    update(value);
  }
}

function useLiveConnection(device: string) {
  const { store } = useConnection();
  const [live, setLive] = useState<LiveView>();
  const [frame, setFrame] = useState<ScreenFrame>();
  const [control, setControl] = useState<LiveUpdate['control']>('paused');
  const [error, setError] = useState<{ key: StringKey; code?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let active: LiveView | undefined;
    const update = (value: LiveUpdate) => {
      setControl(value.control);
      if (value.frame) setFrame(value.frame);
      if (value.error) setError({ key: 'liveViewFailed', code: value.error.code });
    };
    void (async () => {
      try {
        if (!store.client) throw new Error('offline');
        active = await store.client.openLiveView(device, {
          maxDimension: Math.min(2560, Math.max(640, Math.round(window.innerWidth * window.devicePixelRatio))),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return active.close();
        setLive(active);
        await receiveLive(active, controller.signal, update);
        if (!controller.signal.aborted) setControl('paused');
      } catch (error) {
        if (controller.signal.aborted) return;
        setControl('paused');
        const code = (error as { code?: string }).code ?? '';
        setError({
          key: ['tls-required', 'secure-context-required'].includes(code) ? 'liveTlsRequired' : 'liveViewFailed',
        });
      }
    })();
    return () => {
      controller.abort();
      active?.close();
    };
  }, [device, store]);
  return { live, frame, control, error, setError };
}

export function useLiveStream(device: string) {
  const stream = useLiveConnection(device);
  const { live, frame, control, setError } = stream;
  const [pending, setPending] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ownership transitions acknowledge the pending request
  useEffect(() => setPending(false), [control]);
  const send = (tool: string, args: Record<string, unknown>, source = frame) => {
    if (control !== 'owner' || !source || !live) return;
    void live
      .input(tool, { displayId: source.displayId, captureId: source.captureId, ...args })
      .catch(() => setError({ key: 'liveInputFailed' }));
  };
  const take = async () => {
    if (!live) return;
    setPending(true);
    setError(undefined);
    try {
      if (control === 'owner') await live.handBack();
      else await live.takeOver();
    } catch {
      setPending(false);
      setError({ key: 'liveInputFailed' });
    }
  };
  return { ...stream, pending, send, take };
}

export function useFrameImage(frame?: ScreenFrame) {
  const [image, setImage] = useState('');
  useEffect(() => {
    if (!frame) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(frame.image)], { type: frame.mime }));
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [frame]);
  return image;
}
