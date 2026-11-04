import { useShellNavigation, useChatSwipe, goHome, type ShellNavigation } from './shellNavigation';
import { useTheme } from './design/theme';
import { Preferences } from './preferences';
import { Sidebar } from './shell';
import { Home } from './home';
import { MessagePhotos, ToolAttachments } from './media';
import { ModelsPage } from './models';
import { PhotoButton, PhotoConsent, PhotoDrafts, usePhotoConsent, usePhotoDrafts } from './photos';
import { isPhoto } from './photoState';
import { PluginsProvider, PluginsPage } from './plugins';
import { MemoryPage } from './memory';
import { ApprovalCard } from './approvals';
import { localizedError } from '@swiftnest/api';
import { LanguageSync } from './languageSync';
import { TransfersPage, TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { DeviceHubProvider, DeviceApprovals, DevicesPage } from './devices';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { IconButton } from './components/IconButton';
import { Sheet } from './components/Sheet';
import { DetailPage, FormPage } from './components/pages';
import { VirtualList } from './components/VirtualList';
import { icons } from './design/icons';
import { useI18n } from './i18n';
import { hasPrecisePointer } from './runtime';
import { useConnection } from './connection';
import { chatReducer, emptyChat } from './chat';
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
function TranscriptRow({
  row,
  sessionId,
  onAnswered,
}: {
  row: ChatRow;
  sessionId: string;
  onAnswered: (requestId: string) => void;
}) {
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
  if (row.kind === 'approval') return <ApprovalCard request={row} onAnswered={onAnswered} />;
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
  const [ready, setReady] = useState(false);
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
          if (event.type === 'turn-end' || event.type === 'assistant-start') void store.refresh();
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
  return { state, dispatch, ready };
}

type ChatSession = ReturnType<typeof useChatSession>;
type InitialMessage = { initialMessage?: string; onInitialMessageConsumed: () => void };
type ChatDraftProps = InitialMessage & { sessionId: string; ready: boolean; dispatch: ChatSession['dispatch'] };

function useChatDraft({ sessionId, ready, dispatch, initialMessage, onInitialMessageConsumed }: ChatDraftProps) {
  const { t } = useI18n();
  const { store } = useConnection();
  const { client } = store;
  const [draft, setDraft] = useState(initialMessage ?? '');
  const pendingMessage = useRef(initialMessage);
  const photos = usePhotoDrafts();
  useEffect(() => {
    if (!ready || !client || !pendingMessage.current) return;
    const text = pendingMessage.current;
    pendingMessage.current = undefined;
    onInitialMessageConsumed();
    setDraft('');
    dispatch({ type: 'waiting' });
    void client.sendMessage(sessionId, text).catch(() => {
      setDraft(text);
      dispatch({ type: 'error', sessionId, code: 'send-failed', message: t('sendFailed') });
    });
  }, [ready, client, sessionId, t, onInitialMessageConsumed, dispatch]);
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
  return { draft, setDraft, photos, send };
}

function ChatInput({
  draft,
  setDraft,
  photos,
}: Pick<ReturnType<typeof useChatDraft>, 'draft' | 'setDraft' | 'photos'>) {
  const { t } = useI18n();
  return (
    <textarea
      aria-label={t('composer')}
      placeholder={t('composer')}
      rows={1}
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
  );
}

function ChatComposer({ waiting, ...props }: ChatDraftProps & { waiting: boolean }) {
  const { t } = useI18n();
  const { status } = useConnection();
  const { draft, setDraft, photos, send } = useChatDraft(props);
  const consent = usePhotoConsent(photos.drafts.length > 0);
  const [hasKeyboard] = useState(hasPrecisePointer);
  const Send = icons.send;
  return (
    <div className="composer-area">
      {waiting && <Thinking />}
      {(waiting || hasKeyboard) && <p className="composer-notice">{t(waiting ? 'queueHelp' : 'sendHelp')}</p>}
      {photos.failed && <p role="alert">{t('photoFailed')}</p>}
      <PhotoDrafts drafts={photos.drafts} remove={photos.remove} />
      <PhotoConsent consent={consent} />
      <form className="composer card" onSubmit={send}>
        <PhotoButton disabled={photos.full || status !== 'connected'} add={(files) => void photos.add(files)} />
        <ChatInput draft={draft} setDraft={setDraft} photos={photos} />
        <IconButton
          type="submit"
          variant="primary"
          disabled={(!draft.trim() && !photos.drafts.length) || !props.ready || status !== 'connected'}
          aria-label={t('send')}
        >
          <Send size={24} />
        </IconButton>
      </form>
    </div>
  );
}

function ChatTranscript({
  sessionId,
  state,
  dispatch,
}: Pick<ChatSession, 'state' | 'dispatch'> & { sessionId: string }) {
  const { t } = useI18n();
  return (
    <VirtualList
      items={state.rows}
      itemKey={(row) => row.id}
      label={t('messages')}
      followEnd
      className="transcript"
      renderItem={(row) => (
        <TranscriptRow
          row={row}
          sessionId={sessionId}
          onAnswered={(requestId) => dispatch({ type: 'approval-answered', requestId })}
        />
      )}
    />
  );
}

function ChatDetail({
  sessionId,
  onBack,
  onOptions,
  ...initial
}: InitialMessage & {
  sessionId: string;
  onBack: () => void;
  onOptions: () => void;
}) {
  const { t } = useI18n();
  const { status, root, sessions } = useConnection();
  const { state, dispatch, ready } = useChatSession(sessionId);
  const Options = icons.settings;
  return (
    <DetailPage
      title={sessions.find((session) => session.sessionId === sessionId)?.title || t('untitledChat')}
      subtitle={root || t(status)}
      onBack={onBack}
      action={
        <IconButton variant="ghost" aria-label={t('chatActions')} onClick={onOptions}>
          <Options size={24} />
        </IconButton>
      }
    >
      <ConnectionStatus quiet />
      <DeviceApprovals compact />
      <TransferCards compact />
      <LiveDeviceButton />
      <ChatTranscript sessionId={sessionId} state={state} dispatch={dispatch} />
      <ChatComposer sessionId={sessionId} waiting={state.waiting} ready={ready} dispatch={dispatch} {...initial} />
    </DetailPage>
  );
}
export function App() {
  return (
    <DeviceHubProvider>
      <PluginsProvider>
        <AppContent />
      </PluginsProvider>
    </DeviceHubProvider>
  );
}
function AppRoutes({ navigation }: { navigation: ShellNavigation }) {
  const { hash, chatId, initialMessage, consumeInitialMessage, openPreferences, creating, newChat } = navigation;
  const { status } = useConnection();
  if (hash.startsWith('#/models')) return <ModelsPage onBack={goHome} />;
  if (hash.startsWith('#/plugins')) return <PluginsPage onBack={goHome} />;
  if (hash.startsWith('#/memory')) return <MemoryPage key={status} onBack={goHome} />;
  if (hash.startsWith('#/transfers')) return <TransfersPage onBack={goHome} />;
  if (hash.startsWith('#/devices')) return <DevicesPage onBack={goHome} />;
  if (hash.startsWith('#/pair')) return <PairPage onBack={goHome} />;
  if (chatId)
    return (
      <ChatDetail
        key={`${chatId}:${status}`}
        sessionId={chatId}
        initialMessage={initialMessage?.id === chatId ? initialMessage.text : undefined}
        onInitialMessageConsumed={consumeInitialMessage}
        onBack={goHome}
        onOptions={openPreferences}
      />
    );
  return (
    <>
      <ConnectionStatus quiet />
      <Home creating={creating} onSend={newChat} />
    </>
  );
}

function ShellSidebar({ navigation }: { navigation: ShellNavigation }) {
  const { t } = useI18n();
  const { chatId, creating, newChat, closeDrawer, openPreferences, drawer } = navigation;
  const content = (
    <Sidebar
      chatId={chatId}
      creating={creating}
      onNewChat={() => void newChat()}
      onNavigate={closeDrawer}
      onPreferences={openPreferences}
    />
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
  return (
    <header className="phone-header">
      <IconButton
        aria-label={t('shell.openNavigation')}
        aria-expanded={navigation.drawer}
        onClick={navigation.openDrawer}
      >
        <Menu size={24} />
      </IconButton>
      <span>{t('appName')}</span>
      <IconButton aria-label={t('openPreferences')} onClick={navigation.openPreferences}>
        <Settings size={24} />
      </IconButton>
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

function AppContent() {
  const navigation = useShellNavigation();
  const { reducedMotion } = useTheme();
  const { offset, ...swipeHandlers } = useChatSwipe(navigation.chatId, navigation.hash);
  const style =
    offset && !reducedMotion
      ? ({ transform: `translateX(${offset}px)`, animation: 'none' } as CSSProperties)
      : undefined;
  return (
    <div className="app-shell">
      <LanguageSync />
      <SkipLink />
      <ShellSidebar navigation={navigation} />
      <main id="main-content" className="main-content" tabIndex={-1} {...swipeHandlers}>
        <PhoneHeader navigation={navigation} />
        <div
          key={navigation.hash}
          className="route-view"
          data-direction={navigation.chatId ? 'forward' : 'back'}
          style={style}
        >
          <AppRoutes navigation={navigation} />
        </div>
      </main>
      <Preferences open={navigation.preferences} onClose={navigation.closePreferences} />
    </div>
  );
}
