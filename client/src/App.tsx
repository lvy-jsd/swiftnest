import { useShellNavigation, useChatSwipe, goHome, type ShellNavigation } from './shellNavigation';
import { useChatSwipeStyle, useRouteTransition } from './shellNavigation';
import { PageNavigationProvider } from './components/PageNavigation';
import { Preferences } from './preferences';
import { Sidebar } from './shell';
import { Home } from './home';
import { MessagePhotos, ToolAttachments } from './media';
import { ModelsPage } from './models';
import { Composer, ComposerProvider } from './composer';
import { PluginsProvider, PluginsPage } from './plugins';
import { MemoryPage } from './memory';
import { ApprovalCard } from './approvals';
import { ApprovalInboxProvider } from './inboxState';
import { ApprovalBadge, ApprovalInboxPage } from './inbox';
import { localizedError, type SwiftnestClient } from '@swiftnest/api';
import { LanguageSync } from './languageSync';
import { TransfersPage, TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { DeviceHubProvider, DeviceApprovals, DevicesPage } from './devices';
import { useEffect, useReducer, useRef, useState } from 'react';
import { IconButton } from './components/IconButton';
import { Sheet } from './components/Sheet';
import { DetailPage, FormPage } from './components/pages';
import { VirtualList } from './components/VirtualList';
import { icons } from './design/icons';
import { useI18n } from './i18n';
import { useConnection } from './connection';
import { chatReducer, emptyChat } from './chat';
import { watchChatSession } from './chatSession';
import type { ChatRow } from './chat';

export { chatFromHash } from './shellNavigation';

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
function useChatSession(sessionId: string) {
  const { t } = useI18n();
  const { store, status } = useConnection();
  const { client } = store;
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChat);
  const [readyClient, setReadyClient] = useState<SwiftnestClient>();
  // A language switch must not drop and re-follow the chat, so `t` is read but not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client || status !== 'connected') return;
    return watchChatSession(client, sessionId, {
      ready: (ready) => setReadyClient(ready ? client : undefined),
      event(event) {
        dispatch(event);
        if (event.type === 'turn-end' || event.type === 'assistant-start') void store.refresh();
      },
      failed() {
        if (!store.getSnapshot().pluginRestart)
          dispatch({ type: 'error', sessionId, code: 'follow-failed', message: t('followFailed') });
      },
    });
  }, [client, sessionId, status, store]);
  return { state, dispatch, ready: !!client && status === 'connected' && readyClient === client };
}

type ChatSession = ReturnType<typeof useChatSession>;
function ChatTranscript({ sessionId, state }: Pick<ChatSession, 'state'> & { sessionId: string }) {
  const { t } = useI18n();
  return (
    <VirtualList
      items={state.rows}
      itemKey={(row) => row.id}
      label={t('messages')}
      followEnd
      className="transcript"
      renderItem={(row) => <TranscriptRow row={row} sessionId={sessionId} />}
    />
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
  const { status, sessions } = useConnection();
  const { state, ready } = useChatSession(sessionId);
  return (
    <DetailPage
      title={sessions.find((session) => session.sessionId === sessionId)?.title || t('untitledChat')}
      subtitle={t(state.waiting ? 'thinking' : status)}
      onBack={onBack}
      onTitleClick={onOptions}
    >
      <ConnectionStatus quiet />
      <DeviceApprovals />
      <TransferCards compact />
      <LiveDeviceButton />
      <ChatTranscript sessionId={sessionId} state={state} />
      {state.waiting && <Thinking />}
      <Composer draftKey={sessionId} waiting={state.waiting} ready={ready} />
    </DetailPage>
  );
}
export function App() {
  return (
    <DeviceHubProvider>
      <ApprovalInboxProvider>
        <PluginsProvider>
          <ComposerProvider>
            <AppContent />
          </ComposerProvider>
        </PluginsProvider>
      </ApprovalInboxProvider>
    </DeviceHubProvider>
  );
}
function AppRoutes({ navigation }: { navigation: ShellNavigation }) {
  const { page, chatId, openPreferences } = navigation;
  const { status } = useConnection();
  if (page === 'approvals') return <ApprovalInboxPage onBack={goHome} />;
  if (page === 'models') return <ModelsPage onBack={goHome} />;
  if (page === 'plugins') return <PluginsPage onBack={goHome} />;
  if (page === 'memory') return <MemoryPage key={status} onBack={goHome} />;
  if (page === 'transfers') return <TransfersPage onBack={goHome} />;
  if (page === 'devices') return <DevicesPage onBack={goHome} />;
  if (page === 'pair') return <PairPage onBack={goHome} />;
  if (chatId) return <ChatDetail key={chatId} sessionId={chatId} onBack={goHome} onOptions={openPreferences} />;
  return (
    <>
      <ConnectionStatus quiet />
      <Home />
    </>
  );
}

function ShellSidebar({ navigation }: { navigation: ShellNavigation }) {
  const { t } = useI18n();
  const { chatId, newChat, closeDrawer, openPreferences, drawer } = navigation;
  const content = (
    <Sidebar chatId={chatId} onNewChat={newChat} onNavigate={closeDrawer} onPreferences={openPreferences} />
  );
  return (
    <>
      <aside className="sidebar card">{content}</aside>
      <Sheet open={drawer} onClose={closeDrawer} title={t('shell.navigation')} presentation="drawer">
        {content}
      </Sheet>
    </>
  );
}

function PhoneHeader({ navigation }: { navigation: ShellNavigation }) {
  const { t } = useI18n();
  const Menu = icons.menu;
  const Settings = icons.settings;
  const Write = icons.write;
  const { status } = useConnection();
  if (navigation.page !== 'home') return null;
  return (
    <header className="phone-header">
      <IconButton
        aria-label={t('shell.openNavigation')}
        aria-expanded={navigation.drawer}
        onClick={navigation.openDrawer}
      >
        <Menu size={24} />
      </IconButton>
      <div className="phone-header__actions">
        <ApprovalBadge />
        {status === 'connected' && (
          <IconButton aria-label={t('newChat')} onClick={navigation.newChat}>
            <Write size={20} />
          </IconButton>
        )}
        <IconButton aria-label={t('openPreferences')} onClick={navigation.openPreferences}>
          <Settings size={24} />
        </IconButton>
      </div>
    </header>
  );
}

function SkipLink() {
  const { t } = useI18n();
  return (
    // biome-ignore lint/a11y/useValidAnchor: a real skip link; following the href would change the route hash
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
  );
}

function RouteAnnouncement({ hash }: { hash: string }) {
  const [title, setTitle] = useState('');
  const { t } = useI18n();
  // Read the rendered heading so route announcements and visible titles stay in sync.
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce every route change
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const headings = document.getElementById('main-content')?.querySelectorAll('h1') ?? [];
      const heading = [...headings].find((element) => element.getClientRects().length > 0);
      const label = heading?.textContent || t('appName');
      setTitle(label);
      document.title = `${label} · ${t('appName')}`;
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, t]);
  return (
    <span className="sr-only" role="status">
      {title}
    </span>
  );
}

function AppContent() {
  const navigation = useShellNavigation();
  const { offset, ...swipeHandlers } = useChatSwipe(navigation.chatId, navigation.hash);
  const style = useChatSwipeStyle(offset);
  const routeView = useRouteTransition(navigation.routeKey);
  return (
    <div className="app-shell">
      <LanguageSync />
      <SkipLink />
      <RouteAnnouncement hash={navigation.hash} />
      <ShellSidebar navigation={navigation} />
      <PageNavigationProvider value={navigation}>
        <main id="main-content" className="main-content" tabIndex={-1} {...swipeHandlers}>
          <PhoneHeader navigation={navigation} />
          <div ref={routeView} className="route-view" style={style}>
            <AppRoutes navigation={navigation} />
          </div>
        </main>
      </PageNavigationProvider>
      <Preferences open={navigation.preferences} onClose={navigation.closePreferences} />
    </div>
  );
}
