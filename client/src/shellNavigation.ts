import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useConnection } from './connection';
import { isTauriRuntime } from './runtime';
import { breakpoints } from './design/tokens';

export function chatFromHash(hash: string): string | undefined {
  const match = /^#\/chats\/([^/?#]+)$/.exec(hash);
  try {
    return match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    return undefined;
  }
}

export function goHome() {
  window.location.hash = '/';
}

function useAndroidBack(consume: () => boolean) {
  const handler = useRef(consume);
  handler.current = consume;
  useEffect(() => {
    if (!isTauriRuntime() || !/Android/i.test(navigator.userAgent)) return;
    let disposed = false;
    let unregister: (() => void) | undefined;
    void import('./androidBack')
      .then((module) => module.registerAndroidBack(() => handler.current()))
      .then((cleanup) => {
        if (disposed) cleanup();
        else unregister = cleanup;
      });
    return () => {
      disposed = true;
      unregister?.();
    };
  }, []);
}

function useRoute() {
  const { store } = useConnection();
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '#/' : window.location.hash));
  useEffect(() => {
    const navigate = () => setHash(window.location.hash);
    const shortcut = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goHome();
      }
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') void store.refresh();
    };
    window.addEventListener('hashchange', navigate);
    window.addEventListener('keydown', shortcut);
    document.addEventListener('visibilitychange', refresh);
    const poll = setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('keydown', shortcut);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(poll);
    };
  }, [store]);
  useEffect(() => {
    document.getElementById('main-content')?.focus({ preventScroll: true });
    if (!chatFromHash(hash) && !hash.startsWith('#/pair')) void store.refresh();
  }, [hash, store]);
  return hash;
}

export function useChatSwipe(chatId: string | undefined, hash: string) {
  const [offset, setOffset] = useState(0);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every route change
  useEffect(() => setOffset(0), [hash]);
  const cancel = () => {
    swipe.current = null;
    setOffset(0);
  };
  const start = (event: PointerEvent<HTMLElement>) => {
    if (chatId && window.innerWidth < breakpoints.tablet && event.clientX <= 32 && event.isPrimary)
      swipe.current = { x: event.clientX, y: event.clientY };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    if (!swipe.current) return;
    if (Math.abs(event.clientY - swipe.current.y) > 48) return cancel();
    const distance = Math.max(0, event.clientX - swipe.current.x);
    if (distance > 8 && !event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.setPointerCapture(event.pointerId);
    setOffset(distance);
  };
  const end = () => {
    if (offset > Math.min(120, window.innerWidth / 4)) goHome();
    cancel();
  };
  return { offset, onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: cancel };
}

function useNewChat(closeDrawer: () => void) {
  const { store } = useConnection();
  const [creating, setCreating] = useState(false);
  const inFlight = useRef(false);
  const [initialMessage, setInitialMessage] = useState<{ id: string; text: string }>();
  const newChat = async (text = '') => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setCreating(true);
    try {
      const id = await store.newChat();
      if (!id) return false;
      setInitialMessage(text ? { id, text } : undefined);
      closeDrawer();
      window.location.hash = `/chats/${encodeURIComponent(id)}`;
      return true;
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  };
  return { creating, initialMessage, newChat, consumeInitialMessage: () => setInitialMessage(undefined) };
}

export function useShellNavigation() {
  const hash = useRoute();
  const [preferences, setPreferences] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = () => setDrawer(false);
  const chat = useNewChat(closeDrawer);
  useEffect(() => {
    const close = () => setDrawer(false);
    const tablet = window.matchMedia(`(min-width: ${breakpoints.tablet}px)`);
    const resize = () => {
      if (tablet.matches) close();
    };
    window.addEventListener('hashchange', close);
    tablet.addEventListener('change', resize);
    return () => {
      window.removeEventListener('hashchange', close);
      tablet.removeEventListener('change', resize);
    };
  }, []);
  useAndroidBack(() => {
    if (preferences) setPreferences(false);
    else if (drawer) setDrawer(false);
    else if (hash && hash !== '#/' && hash !== '#') goHome();
    else return false;
    return true;
  });
  const openPreferences = () => {
    closeDrawer();
    setPreferences(true);
  };
  return {
    hash,
    chatId: chatFromHash(hash),
    preferences,
    drawer,
    openPreferences,
    closePreferences: () => setPreferences(false),
    openDrawer: () => setDrawer(true),
    closeDrawer,
    ...chat,
  };
}
export type ShellNavigation = ReturnType<typeof useShellNavigation>;
