import { ChatList } from './chatList';
import { ChatSearchAdvanced } from './chatSearchSettings';
import { MessagePhotos, ToolAttachments } from './media';
import { ModelsPage } from './models';
import { PhotoButton, PhotoConsent, PhotoDrafts, usePhotoConsent, usePhotoDrafts } from './photos';
import { isPhoto } from './photoState';
import { RelaySettings } from './relaySettings';
import { PluginsProvider, PluginsPage, usePlugins } from './plugins';
import { MemoryPage } from './memory';
import { ApprovalInboxProvider } from './inboxState';
import { ApprovalBadge, ApprovalInboxPage } from './inbox';
import { ApprovalSettingsFields } from './approvalSettings';
import { ApprovalCard } from './approvals';
import { localizedError } from '@swiftnest/api';
import { LanguageSync } from './languageSync';
import { TransfersPage, TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { DeviceHubProvider, DevicesPage } from './devices';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, PointerEvent } from 'react';
import { Button } from './components/Button';
import { IconButton } from './components/IconButton';
import { AppearanceSettings } from './components/AppearanceSettings';
import { Sheet } from './components/Sheet';
import { DetailPage, FormPage, HubPage } from './components/pages';
import { VirtualList } from './components/VirtualList';
import { icons } from './design/icons';
import { useTheme } from './design/theme';
import { breakpoints } from './design/tokens';
import { useI18n } from './i18n';
import type { Locale } from './i18n';
import { hasPrecisePointer, isTauriRuntime } from './runtime';
import { useConnection } from './connection';
import { chatReducer, emptyChat } from './chat';
import type { ChatRow } from './chat';

export function chatFromHash(hash: string): string | undefined {
  const match = /^#\/chats\/([^/?#]+)$/.exec(hash);
  try {
    return match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    return undefined;
  }
}
export function pairingFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash;
  return (
    new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '').get('url') ??
    new URLSearchParams(window.location.search).get('url') ??
    ''
  );
}
function clearPairingLocation() {
  const url = new URL(window.location.href);
  url.searchParams.delete('url');
  url.hash = '/pair';
  window.history.replaceState(null, '', url);
}
function Preferences({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const theme = useTheme();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('preferences')}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      <div className="field-groups">
        <label className="field">
          <span>{t('language')}</span>
          <select
            aria-label={t('language')}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="zh-CN">{t('chinese')}</option>
            <option value="en">{t('english')}</option>
          </select>
        </label>
        <AppearanceSettings />
        <label className="field">
          <span>{t('customHue')}</span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={theme.accentHue}
            onChange={(event) => theme.setAccentHue(Number(event.target.value))}
          />
        </label>
        <label className="switch-field">
          <span>{t('reduceMotion')}</span>
          <input
            type="checkbox"
            role="switch"
            checked={theme.reduceMotion}
            aria-checked={theme.reduceMotion}
            onChange={(event) => theme.setReduceMotion(event.target.checked)}
          />
        </label>
        <label className="switch-field">
          <span>{t('reduceTransparency')}</span>
          <input
            type="checkbox"
            role="switch"
            checked={theme.reduceTransparency}
            aria-checked={theme.reduceTransparency}
            onChange={(event) => theme.setReduceTransparency(event.target.checked)}
          />
        </label>
        <ApprovalSettingsFields />
        <ChatSearchAdvanced />
        <RelaySettings />
      </div>
    </Sheet>
  );
}

/** `quiet` hides the row while all is well (the chat header already shows the server). */
function ConnectionStatus({ quiet = false }: { quiet?: boolean }) {
  const { status, root, error } = useConnection();
  const { t } = useI18n();
  if (quiet && status === 'connected' && !error) return null;
  return (
    <div className="connection-status">
      <p role="status">
        {t(status)}
        {root ? ` · ${root}` : ''}
      </p>
      {error && <p role="alert">{t(error)}</p>}
      <a href="#/pair">{t(status === 'connected' ? 'reconnect' : 'pair')}</a>
    </div>
  );
}
/** After pairing again, a settings page that restarted the assistant gets its owner back. */
export function pairingReturn(hash: string, restarting: boolean): string {
  if (hash.includes('return=models')) return '/models';
  return hash.includes('return=plugins') || restarting ? '/plugins' : '/';
}
function PairPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { store, status, error, root } = useConnection();
  const [url, setUrl] = useState(pairingFromLocation);
  const opened = useRef(false);
  const returnTo = useRef(pairingReturn(window.location.hash, !!store.getSnapshot().pluginRestart));
  async function pair(value: string) {
    setUrl('');
    clearPairingLocation();
    if (await store.pair(value)) window.location.hash = returnTo.current;
  }
  // Pair once from a link that opened the App; later edits go through the form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const value = pairingFromLocation();
    clearPairingLocation();
    if (value) void pair(value);
  }, []);
  return (
    <FormPage
      title={t('pair')}
      subtitle={t('pairHelp')}
      onBack={onBack}
      saveLabel={t('pair')}
      saveDisabled={status === 'connecting' || !url.trim()}
      onSave={(event) => {
        event.preventDefault();
        if (url.trim()) void pair(url.trim());
      }}
    >
      <label className="field">
        <span>{t('pairUrl')}</span>
        <input
          type="url"
          required
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <p role="status">
        {t(status)}
        {root ? ` · ${root}` : ''}
      </p>
      {error && <p role="alert">{t(error)}</p>}
    </FormPage>
  );
}
function Thinking() {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="thinking-pill" role="status">
      {t('thinking')} · {seconds} {t('seconds')}
    </p>
  );
}
function TranscriptRow({ row, sessionId }: { row: ChatRow; sessionId: string }) {
  const { t, locale } = useI18n();
  const { assistantName } = useConnection();
  if (row.kind === 'message') {
    if (!row.text && !row.images?.length) return null;
    const author = row.role === 'user' ? t('you') : (assistantName ?? t('assistant'));
    return (
      <article
        className={`message${row.role === 'user' ? ' message--own' : ''}`}
        data-streaming={!row.final || undefined}
      >
        <div className="message__body">
          <strong>{author}</strong>
          <MessagePhotos sessionId={sessionId} images={row.images} />
          {row.text && <p>{row.text}</p>}
        </div>
      </article>
    );
  }
  if (row.kind === 'approval') return <ApprovalCard request={row} />;
  if (row.kind === 'error') {
    const failure = localizedError({ code: row.code, message: row.text }, locale);
    return (
      <p className="inline-error" role="alert">
        {failure.message}
        <br />
        {failure.hint} ({failure.code})
      </p>
    );
  }
  if (row.kind === 'tools')
    return (
      <div>
        <ToolAttachments calls={row.calls} />
        <details key={String(row.finished)} className="event-card">
          <summary>
            {t(row.finished ? 'ranTools' : 'runningTools').replace('{count}', String(Object.keys(row.calls).length))}
          </summary>
          <pre>{JSON.stringify(row.calls, null, 2)}</pre>
        </details>
      </div>
    );
  return (
    <details className="event-card">
      <summary>{t('unknownEvent')}</summary>
      <pre>{JSON.stringify(row.event, null, 2)}</pre>
    </details>
  );
}
function ChatDetail({
  sessionId,
  onBack,
  onOptions,
}: {
  sessionId: string;
  onBack: () => void;
  onOptions: () => void;
}) {
  const { t } = useI18n();
  const { store, status, root, sessions } = useConnection();
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChat);
  const [draft, setDraft] = useState('');
  const photos = usePhotoDrafts();
  const consent = usePhotoConsent(photos.drafts.length > 0);
  const [hasKeyboard] = useState(hasPrecisePointer);
  const [ready, setReady] = useState(false);
  const { client } = store;
  const Send = icons.send,
    Options = icons.settings;
  // A language switch must not drop and re-follow the chat, so `t` is read but not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client || status !== 'connected') return;
    const controller = new AbortController();
    let ended = false;
    void (async () => {
      try {
        const subscription = await client.follow(sessionId, { signal: controller.signal });
        if (ended) {
          subscription.close();
          return;
        }
        setReady(true);
        for await (const event of subscription) {
          if (ended) break;
          dispatch(event);
          if (event.type === 'turn-end') void store.refresh();
        }
        if (!ended) setReady(false);
      } catch {
        if (!ended) {
          setReady(false);
          if (!store.getSnapshot().pluginRestart)
            dispatch({ type: 'error', sessionId, code: 'follow-failed', message: t('followFailed') });
        }
      }
    })();
    return () => {
      ended = true;
      controller.abort();
    };
  }, [client, sessionId, status, store]);
  function send(event: FormEvent) {
    event.preventDefault();
    if ((!draft.trim() && !photos.drafts.length) || !ready || !client) return;
    const text = draft.trim();
    setDraft('');
    dispatch({ type: 'waiting' });
    void client.sendMessage(sessionId, text, photos.take()).catch(() => {
      dispatch({ type: 'error', sessionId, code: 'send-failed', message: t('sendFailed') });
    });
  }
  return (
    <DetailPage
      title={sessions.find((s) => s.sessionId === sessionId)?.title || t('untitledChat')}
      subtitle={root || t(status)}
      onBack={onBack}
      action={
        <IconButton variant="ghost" aria-label={t('chatActions')} onClick={onOptions}>
          <Options size={24} />
        </IconButton>
      }
    >
      <ConnectionStatus quiet />
      <TransferCards compact />
      <LiveDeviceButton />
      <VirtualList
        items={state.rows}
        itemKey={(row) => row.id}
        label={t('messages')}
        followEnd
        className="transcript"
        renderItem={(row) => <TranscriptRow row={row} sessionId={sessionId} />}
      />
      <div className="composer-area glass">
        {state.waiting && <Thinking />}
        {(state.waiting || hasKeyboard) && (
          <p className="composer-notice">{t(state.waiting ? 'queueHelp' : 'sendHelp')}</p>
        )}
        {photos.failed && <p role="alert">{t('photoFailed')}</p>}
        <PhotoDrafts drafts={photos.drafts} remove={photos.remove} />
        <PhotoConsent consent={consent} />
        <form className="composer" onSubmit={send}>
          <PhotoButton disabled={photos.full || status !== 'connected'} add={(files) => void photos.add(files)} />
          <textarea
            aria-label={t('composer')}
            placeholder={t('composer')}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files].filter(isPhoto);
              if (!pasted.length) return;
              event.preventDefault();
              void photos.add(pasted);
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <IconButton
            type="submit"
            variant="primary"
            disabled={(!draft.trim() && !photos.drafts.length) || !ready || status !== 'connected'}
            aria-label={t('send')}
          >
            <Send size={24} />
          </IconButton>
        </form>
      </div>
    </DetailPage>
  );
}
export function App() {
  return (
    <DeviceHubProvider>
      <ApprovalInboxProvider>
        <PluginsProvider>
          <AppContent />
        </PluginsProvider>
      </ApprovalInboxProvider>
    </DeviceHubProvider>
  );
}
function goHome() {
  window.location.hash = '/';
}
function AppContent() {
  const { t } = useI18n();
  const { reducedMotion } = useTheme();
  const { store, status } = useConnection();
  const { owner } = usePlugins();
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '#/' : window.location.hash));
  const [preferences, setPreferences] = useState(false);
  const [creating, setCreating] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const chatId = chatFromHash(hash);
  const pairing = hash.startsWith('#/pair');
  const devicesPage = hash.startsWith('#/devices');
  const pluginsPage = hash.startsWith('#/plugins');
  const modelsPage = hash.startsWith('#/models');
  const transfersPage = hash.startsWith('#/transfers');
  const approvalsPage = hash.startsWith('#/approvals');
  const memoryPage = hash.startsWith('#/memory');
  const Settings = icons.settings,
    Avatar = icons.avatar;
  // Read current state without re-registering the async native listener on every
  // route/sheet change. StrictMode may clean up before registration resolves.
  const consumeBack = useRef<() => boolean>(() => false);
  consumeBack.current = () => {
    if (preferences) {
      setPreferences(false);
      return true;
    }
    if (hash && hash !== '#/' && hash !== '#') {
      goHome();
      return true;
    }
    return false;
  };
  useEffect(() => {
    if (!isTauriRuntime() || !/Android/i.test(navigator.userAgent)) return;
    let disposed = false;
    let unregister: (() => void) | undefined;
    void import('./androidBack')
      .then((module) => module.registerAndroidBack(() => consumeBack.current()))
      .then((cleanup) => {
        if (disposed) cleanup();
        else unregister = cleanup;
      });
    return () => {
      disposed = true;
      unregister?.();
    };
  }, []);
  useEffect(() => {
    const navigate = () => {
      setHash(window.location.hash);
      setSwipeOffset(0);
    };
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
    return () => {
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('keydown', shortcut);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [store]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the new page on every navigation, even within a page
  useEffect(() => {
    document.getElementById('main-content')?.focus({ preventScroll: true });
    if (!chatId && !pairing) void store.refresh();
  }, [hash, chatId, pairing, store]);
  async function newChat() {
    setCreating(true);
    try {
      const id = await store.newChat();
      if (id) window.location.hash = `/chats/${encodeURIComponent(id)}`;
    } finally {
      setCreating(false);
    }
  }
  function startSwipe(event: PointerEvent<HTMLElement>) {
    if (chatId && window.innerWidth < breakpoints.tablet && event.clientX <= 32 && event.isPrimary)
      swipe.current = { x: event.clientX, y: event.clientY };
  }
  function moveSwipe(event: PointerEvent<HTMLElement>) {
    if (!swipe.current) return;
    if (Math.abs(event.clientY - swipe.current.y) > 48) {
      swipe.current = null;
      setSwipeOffset(0);
      return;
    }
    const distance = Math.max(0, event.clientX - swipe.current.x);
    if (distance > 8 && !event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.setPointerCapture(event.pointerId);
    setSwipeOffset(distance);
  }
  function endSwipe() {
    if (swipeOffset > Math.min(120, window.innerWidth / 4)) goHome();
    swipe.current = null;
    setSwipeOffset(0);
  }
  return (
    <div className="app-shell">
      <LanguageSync />
      {/* biome-ignore lint/a11y/useValidAnchor: a real skip link; following the href would change the route hash */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        {t('skipToContent')}
      </a>
      <aside className="sidebar">
        <div className="sidebar__brand">
          <strong>{t('appName')}</strong>
          <IconButton variant="ghost" aria-label={t('openPreferences')} onClick={() => setPreferences(true)}>
            <Settings size={24} />
          </IconButton>
        </div>
        <p className="sidebar__caption">{t(isTauriRuntime() ? 'desktop' : 'web')}</p>
        <a className="devices-link" href="#/devices">
          {t('devices')}
        </a>
        <a className="devices-link" href="#/transfers">
          {t('transfers')}
        </a>
        {owner && (
          <>
            <a className="devices-link" href="#/models">
              {t('modelsTitle')}
            </a>
            <a className="devices-link" href="#/plugins">
              {t('pluginsTitle')}
            </a>
          </>
        )}
        <a className="devices-link" href="#/memory">
          {t('memory')}
        </a>
        <nav aria-label={t('chatNavigation')}>
          <ChatList selected={chatId} />
        </nav>
      </aside>
      <main
        id="main-content"
        className="main-content"
        tabIndex={-1}
        onPointerDown={startSwipe}
        onPointerMove={moveSwipe}
        onPointerUp={endSwipe}
        onPointerCancel={() => {
          swipe.current = null;
          setSwipeOffset(0);
        }}
      >
        <div className="inbox-frame">
          <ApprovalBadge />
          <div
            key={chatId ?? (pairing ? 'pair' : devicesPage ? 'devices' : 'hub')}
            className="route-view"
            data-direction={chatId ? 'forward' : 'back'}
            style={
              swipeOffset && !reducedMotion
                ? ({ transform: `translateX(${swipeOffset}px)`, animation: 'none' } as CSSProperties)
                : undefined
            }
          >
            {approvalsPage ? (
              <ApprovalInboxPage onBack={goHome} />
            ) : modelsPage ? (
              <ModelsPage onBack={goHome} />
            ) : pluginsPage ? (
              <PluginsPage onBack={goHome} />
            ) : memoryPage ? (
              <MemoryPage key={status} onBack={goHome} />
            ) : transfersPage ? (
              <TransfersPage onBack={goHome} />
            ) : devicesPage ? (
              <DevicesPage onBack={goHome} />
            ) : pairing ? (
              <PairPage onBack={goHome} />
            ) : chatId ? (
              <ChatDetail
                key={`${chatId}:${status}`}
                sessionId={chatId}
                onBack={goHome}
                onOptions={() => setPreferences(true)}
              />
            ) : (
              <HubPage
                title={t('chats')}
                subtitle={t('chatsSubtitle')}
                action={
                  <IconButton variant="ghost" aria-label={t('openPreferences')} onClick={() => setPreferences(true)}>
                    <Avatar size={24} />
                  </IconButton>
                }
              >
                <ConnectionStatus />
                <a className="devices-link" href="#/devices">
                  {t('devices')}
                </a>
                <a className="devices-link" href="#/transfers">
                  {t('transfers')}
                </a>
                {owner && (
                  <>
                    <a className="devices-link" href="#/models">
                      {t('modelsTitle')}
                    </a>
                    <a className="devices-link" href="#/plugins">
                      {t('pluginsTitle')}
                    </a>
                  </>
                )}
                <a className="devices-link" href="#/memory">
                  {t('memory')}
                </a>
                <TransferCards compact />
                <LiveDeviceButton />
                {status === 'connected' && (
                  <Button variant="primary" disabled={creating} onClick={() => void newChat()}>
                    {t('newChat')}
                  </Button>
                )}
                <ChatList />
              </HubPage>
            )}
          </div>
        </div>
      </main>
      <Preferences open={preferences} onClose={() => setPreferences(false)} />
    </div>
  );
}
