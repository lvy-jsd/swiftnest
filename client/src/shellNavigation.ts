import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { useConnection } from './connection';
import { isTauriRuntime } from './runtime';
import { breakpoints, durations, easing } from './design/tokens';
import { useTheme } from './design/theme';

export function chatFromHash(hash: string): string | undefined {
  const match = /^#\/chats\/([^/?#]+)$/.exec(hash);
  try {
    return match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    return undefined;
  }
}

export function shellPageFromHash(hash: string) {
  const pages = ['approvals', 'models', 'plugins', 'memory', 'transfers', 'devices', 'pair'] as const;
  const page = pages.find((page) => hash.startsWith(`#/${page}`));
  return page ?? (chatFromHash(hash) ? 'chat' : 'home');
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

function subscribeToRoute(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function useRoute() {
  const { store } = useConnection();
  // A location change is external state: update synchronously before controls can be focused.
  const hash = useSyncExternalStore(
    subscribeToRoute,
    () => window.location.hash,
    () => '#/',
  );
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goHome();
      }
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') void store.refresh();
    };
    window.addEventListener('keydown', shortcut);
    document.addEventListener('visibilitychange', refresh);
    const poll = setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener('keydown', shortcut);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(poll);
    };
  }, [store]);
  useEffect(() => {
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

export function useShellNavigation() {
  const hash = useRoute();
  const page = shellPageFromHash(hash);
  const chatId = chatFromHash(hash);
  const [preferences, setPreferences] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = () => setDrawer(false);
  const newChat = () => {
    closeDrawer();
    goHome();
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus({ preventScroll: true });
    });
  };
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
    chatId,
    page,
    routeKey: chatId ? `/chats/${chatId}` : `/${page}`,
    preferences,
    drawer,
    openPreferences,
    closePreferences: () => setPreferences(false),
    openDrawer: () => setDrawer(true),
    closeDrawer,
    newChat,
  };
}
export type ShellNavigation = ReturnType<typeof useShellNavigation>;

/** Resize changes layout only. Entry motion is owned by actual navigation, never media CSS. */
export function useRouteTransition(route: string) {
  const element = useRef<HTMLDivElement>(null);
  const previous = useRef(route);
  const { reducedMotion } = useTheme();
  useLayoutEffect(() => {
    if (previous.current === route) return;
    previous.current = route;
    if (reducedMotion) return;
    // Keep composer geometry stable even while a newly opened page fades in.
    const animation = element.current?.animate([{ opacity: 0.96 }, { opacity: 1 }], {
      duration: durations.navigation,
      easing: easing.standard,
    });
    return () => animation?.cancel();
  }, [route, reducedMotion]);
  return element;
}

export function useChatSwipeStyle(offset: number): CSSProperties | undefined {
  const { reducedMotion } = useTheme();
  return offset && !reducedMotion ? { transform: `translateX(${offset}px)` } : undefined;
}
