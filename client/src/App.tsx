import { useShellNavigation, useChatSwipe, goHome } from './shellNavigation';
import { useChatSwipeStyle, useRouteTransition } from './shellNavigation';
import { PageNavigationProvider, useShell } from './components/PageNavigation';
import { Slot, SlotRegistryProvider } from './components/Slot';
import { createSlotRegistry, type PanelDef } from './components/slots';
import { Preferences } from './preferences';
import { Sidebar, OnlineSummary } from './shell';
import { Home } from './home';
import { ContextRail } from './contextRail';
import { greetingKey } from './shellState';
import { ModelsPage } from './models';
import { Composer, ComposerProvider } from './composer';
import { PluginsProvider, PluginsPage } from './plugins';
import { MemoryPage } from './memory';
import { ApprovalInboxProvider } from './inboxState';
import { ApprovalBadge, ApprovalInboxPage } from './inbox';
import { LanguageSync } from './languageSync';
import { TransfersPage, TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { DeviceHubProvider, DeviceApprovals, DevicesPage } from './devices';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { IconButton } from './components/IconButton';
import { Sheet } from './components/Sheet';
import { DetailPage, FormPage } from './components/pages';
import { VirtualList } from './components/VirtualList';
import { icons } from './design/icons';
import { useI18n } from './i18n';
import { useConnection } from './connection';
import { EmptyChat, TranscriptRow } from './chatTranscript';

export { chatFromHash } from './shellNavigation';

/** The greeting hour. The top bar and the home page both read it without prop drilling. */
const HourContext = createContext(0);
const useHour = () => useContext(HourContext);

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
/** Only an explicit settings return link overrides home; restore state is not navigation intent. */
export function pairingReturn(hash: string): string {
  const query = hash.indexOf('?');
  const destination = new URLSearchParams(query < 0 ? '' : hash.slice(query + 1)).get('return');
  if (destination === 'models') return '/models';
  return destination === 'plugins' ? '/plugins' : '/';
}
function PairPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { store, status, error, root } = useConnection();
  const [url, setUrl] = useState(pairingFromLocation);
  const opened = useRef(false);
  const returnTo = useRef(pairingReturn(window.location.hash));
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
function useChatSession(sessionId: string) {
  const { t } = useI18n();
  const { store, status } = useConnection();
  const { client } = store;
  const subscribe = useCallback(
    (listener: () => void) => store.chats.subscribe(sessionId, listener),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => store.chats.getSnapshot(sessionId), [store, sessionId]);
  const { state, timeline, ready } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // A language switch must not drop and re-follow the chat, so `t` is read but not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client || status !== 'connected') return;
    store.chats.follow(sessionId, client, {
      event(event) {
        if (event.type === 'turn-end' || event.type === 'assistant-start') void store.refresh();
      },
      failed() {
        if (!store.getSnapshot().pluginRestart)
          return { type: 'error', sessionId, code: 'follow-failed', message: t('followFailed') };
      },
    });
  }, [client, sessionId, status, store]);
  return { state, timeline, ready: !!client && status === 'connected' && ready };
}

type ChatSession = ReturnType<typeof useChatSession>;
function ChatTranscript({
  sessionId,
  state,
  timeline,
  blank,
}: Pick<ChatSession, 'state' | 'timeline'> & { sessionId: string; blank: boolean }) {
  const { t } = useI18n();
  if (blank && !state.rows.length && !state.waiting)
    return (
      // biome-ignore lint/a11y/useSemanticElements: matches the virtual transcript's list semantics
      <div className="virtual-list transcript" role="list" aria-label={t('messages')}>
        <EmptyChat sessionId={sessionId} />
      </div>
    );
  return (
    <VirtualList
      items={state.rows}
      itemKey={(row) => row.id}
      label={t('messages')}
      followEnd
      className="transcript"
      renderItem={(row) => <TranscriptRow row={row} sessionId={sessionId} timeline={timeline} />}
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
  const { state, timeline, ready } = useChatSession(sessionId);
  const session = sessions.find((session) => session.sessionId === sessionId);
  return (
    <DetailPage
      title={session?.title || t('untitledChat')}
      subtitle={t(state.waiting ? 'thinking' : status)}
      onBack={onBack}
      onTitleClick={onOptions}
    >
      <ConnectionStatus quiet />
      <DeviceApprovals />
      <TransferCards compact />
      <LiveDeviceButton />
      <ChatTranscript sessionId={sessionId} state={state} timeline={timeline} blank={session?.blank === true} />
      {state.waiting && <Thinking />}
      <Composer draftKey={sessionId} waiting={state.waiting} ready={ready} />
    </DetailPage>
  );
}

/*
 * Panels of the five-slot shell.
 *
 * Each panel is a zero-prop component that reads the shell from context, so the
 * definition list stays a pure function of the route: a panel never has to be
 * re-created to see fresh state, and the slot never remounts one by accident.
 */

function PhoneHeaderPanel() {
  const { t } = useI18n();
  const navigation = useShell();
  const hour = useHour();
  const { status } = useConnection();
  const Menu = icons.menu;
  const Settings = icons.settings;
  const Write = icons.write;
  return (
    <>
      <IconButton
        aria-label={t('shell.openNavigation')}
        aria-expanded={navigation.drawer}
        onClick={navigation.openDrawer}
      >
        <Menu size={24} />
      </IconButton>
      <span className="phone-header__title">{t(greetingKey(hour))}</span>
      <div className="phone-header__actions">
        {status === 'connected' && (
          <IconButton aria-label={t('newChat')} onClick={navigation.newChat}>
            <Write size={20} />
          </IconButton>
        )}
        <OnlineSummary />
        <IconButton aria-label={t('openPreferences')} onClick={navigation.openPreferences}>
          <Settings size={24} />
        </IconButton>
      </div>
      <ApprovalBadge />
    </>
  );
}

function SidebarPanel() {
  const navigation = useShell();
  return (
    <Sidebar
      chatId={navigation.chatId}
      onNewChat={navigation.newChat}
      onNavigate={navigation.closeDrawer}
      onPreferences={navigation.openPreferences}
    />
  );
}

function NavigationDrawerPanel() {
  const { t } = useI18n();
  const navigation = useShell();
  return (
    <Sheet
      open={navigation.drawer}
      onClose={navigation.closeDrawer}
      title={t('shell.navigation')}
      presentation="drawer"
    >
      <SidebarPanel />
    </Sheet>
  );
}

function PreferencesPanel() {
  const navigation = useShell();
  return <Preferences open={navigation.preferences} onClose={navigation.closePreferences} />;
}

function HomePanel() {
  const hour = useHour();
  return (
    <>
      <ConnectionStatus quiet />
      <Home hour={hour} />
    </>
  );
}

function ChatPanel() {
  const navigation = useShell();
  if (!navigation.chatId) return null;
  return <ChatDetail sessionId={navigation.chatId} onBack={goHome} onOptions={navigation.openPreferences} />;
}

function MemoryPanel() {
  const { status } = useConnection();
  return <MemoryPage key={status} onBack={goHome} />;
}

function ApprovalsPanel() {
  return <ApprovalInboxPage onBack={goHome} />;
}
function ModelsPanel() {
  return <ModelsPage onBack={goHome} />;
}
function PluginsPanel() {
  return <PluginsPage onBack={goHome} />;
}
function TransfersPanel() {
  return <TransfersPage onBack={goHome} />;
}
function DevicesPanel() {
  return <DevicesPage onBack={goHome} />;
}
function PairPanel() {
  return <PairPage onBack={goHome} />;
}

/** The main area shows exactly one page; the route picks it, the page never moves. */
const MAIN_PAGES = {
  approvals: { id: 'main.approvals', titleKey: 'inboxTitle', component: ApprovalsPanel },
  models: { id: 'main.models', titleKey: 'modelsTitle', component: ModelsPanel },
  plugins: { id: 'main.plugins', titleKey: 'pluginsTitle', component: PluginsPanel },
  memory: { id: 'main.memory', titleKey: 'memory', component: MemoryPanel },
  transfers: { id: 'main.transfers', titleKey: 'transfers', component: TransfersPanel },
  devices: { id: 'main.devices', titleKey: 'devices', component: DevicesPanel },
  pair: { id: 'main.pair', titleKey: 'pair', component: PairPanel },
} as const;

function mainPanels(page: string, chatId?: string): PanelDef[] {
  if (page === 'chat' && chatId)
    return [{ id: 'main.chat', slot: 'main', titleKey: 'messages', minWidth: 0, key: chatId, component: ChatPanel }];
  const route = MAIN_PAGES[page as keyof typeof MAIN_PAGES];
  if (route) return [{ ...route, slot: 'main', minWidth: 0 }];
  return [{ id: 'main.home', slot: 'main', titleKey: 'chats', minWidth: 0, component: HomePanel }];
}

/**
 * The whole shell as data: five slots, one panel list. Adding a page or a rail means
 * adding an entry here (or registering one at runtime), never editing the layout.
 */
function shellPanels(page: string, chatId?: string): PanelDef[] {
  return [
    ...(page === 'home'
      ? ([
          {
            id: 'topbar.phone',
            slot: 'topbar',
            titleKey: 'shell.navigation',
            minWidth: 320,
            component: PhoneHeaderPanel,
          },
        ] satisfies PanelDef[])
      : []),
    { id: 'left.sidebar', slot: 'left', titleKey: 'chats', minWidth: 240, component: SidebarPanel },
    ...mainPanels(page, chatId),
    { id: 'right.context', slot: 'right', titleKey: 'rail.context', minWidth: 200, component: ContextRail },
    {
      id: 'overlay.navigation',
      slot: 'overlay',
      titleKey: 'shell.navigation',
      minWidth: 0,
      component: NavigationDrawerPanel,
    },
    { id: 'overlay.preferences', slot: 'overlay', titleKey: 'preferences', minWidth: 0, component: PreferencesPanel },
  ];
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
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const navigation = useShellNavigation();
  const { offset, ...swipeHandlers } = useChatSwipe(navigation.chatId, navigation.hash);
  const style = useChatSwipeStyle(offset);
  const routeView = useRouteTransition(navigation.routeKey);
  const { t } = useI18n();
  // Pure data, so the registry (and every panel identity inside it) is stable per route.
  const panels = useMemo(() => shellPanels(navigation.page, navigation.chatId), [navigation.page, navigation.chatId]);
  const registry = useMemo(() => createSlotRegistry(panels), [panels]);
  return (
    <div className="app-shell">
      <LanguageSync />
      <SkipLink />
      <RouteAnnouncement hash={navigation.hash} />
      <HourContext value={hour}>
        <PageNavigationProvider value={navigation}>
          <SlotRegistryProvider registry={registry}>
            <Slot id="topbar" as="header" className="phone-header" measure={false} />
            <Slot id="left" as="aside" className="sidebar card" label={t('chats')} />
            <main id="main-content" className="main-content" tabIndex={-1} {...swipeHandlers}>
              <div ref={routeView} className="route-view" style={style}>
                <Slot id="main" measure={false} />
              </div>
            </main>
            <Slot id="right" as="aside" className="context-rail" label={t('rail.context')} gap={12} />
            <Slot id="overlay" measure={false} />
          </SlotRegistryProvider>
        </PageNavigationProvider>
      </HourContext>
    </div>
  );
}
