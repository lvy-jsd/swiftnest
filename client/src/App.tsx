import { localizedError } from '@swiftnest/api';
import { LanguageSync } from './languageSync';
import { TransfersPage, TransferCards } from './transfers';
import { LiveDeviceButton } from './liveView';
import { DeviceHubProvider, DeviceApprovals, DevicesPage } from './devices';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, PointerEvent } from 'react';
import type { SessionSummary } from '@swiftnest/api';
import { Button } from './components/Button';
import { DetailPage, FormPage, HubPage, SheetPage } from './components/pages';
import { VirtualList } from './components/VirtualList';
import { icons } from './design/icons';
import { presets } from './design/palette';
import { useTheme } from './design/theme';
import type { ThemePreference } from './design/theme';
import { breakpoints } from './design/tokens';
import { useI18n } from './i18n';
import type { Locale } from './i18n';
import { isTauriRuntime } from './runtime';
import { useConnection } from './connection';
import { chatReducer, emptyChat } from './chat';
import type { ChatRow } from './chat';

export function chatFromHash(hash: string): string | undefined {
  const match = /^#\/chats\/([^/?#]+)$/.exec(hash);
  try { return match ? decodeURIComponent(match[1]!) : undefined; } catch { return undefined; }
}
export function pairingFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash;
  return new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '').get('url')
    ?? new URLSearchParams(window.location.search).get('url') ?? '';
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
  const chosenPreset = Object.entries(presets).find(([, hue]) => hue === theme.accentHue)?.[0] ?? "custom";
  return <SheetPage open={open} onClose={onClose} title={t("preferences")} actions={<Button variant="primary" onClick={onClose}>{t("done")}</Button>}>
    <div className="field-groups">
      <label className="field"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="zh-CN">{t("chinese")}</option><option value="en">{t("english")}</option></select></label>
      <label className="field"><span>{t("appearance")}</span><select value={theme.preference} onChange={event => theme.setPreference(event.target.value as ThemePreference)}>{(["system", "light", "dark"] as const).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
      <label className="field"><span>{t("accent")}</span><select value={chosenPreset} onChange={event => theme.setAccentHue(event.target.value === "custom" ? 0 : presets[event.target.value as keyof typeof presets])}>{Object.keys(presets).map(name => <option key={name} value={name}>{t(name as keyof typeof presets)}</option>)}<option value="custom">{t("custom")}</option></select></label>
      <label className="field"><span>{t("customHue")}</span><input type="range" min={0} max={359} step={1} value={theme.accentHue} onChange={event => theme.setAccentHue(Number(event.target.value))} /></label>
      <label className="switch-field"><span>{t("reduceMotion")}</span><input type="checkbox" checked={theme.reduceMotion} onChange={event => theme.setReduceMotion(event.target.checked)} /></label>
      <label className="switch-field"><span>{t("reduceTransparency")}</span><input type="checkbox" checked={theme.reduceTransparency} onChange={event => theme.setReduceTransparency(event.target.checked)} /></label>
    </div>
  </SheetPage>;
}

function ChatLink({ chat, selected = false }: { chat: SessionSummary; selected?: boolean }) {
  const { t, locale } = useI18n();
  const ChatIcon = icons.chat;
  return <a className="chat-link" href={`#/chats/${encodeURIComponent(chat.sessionId)}`} aria-current={selected ? 'page' : undefined}>
    <span className="avatar"><ChatIcon size={24} weight={selected ? 'fill' : 'regular'} aria-hidden="true" /></span>
    <span className="chat-link__copy"><strong>{chat.title || t('untitledChat')}</strong><time dateTime={new Date(chat.updatedAt).toISOString()}>{new Date(chat.updatedAt).toLocaleString(locale)}</time></span>
  </a>;
}
function ConnectionStatus() {
  const { status, root, error } = useConnection();
  const { t } = useI18n();
  return <div className="connection-status"><p role="status">{t(status)}{root ? ` · ${root}` : ''}</p>
    {error && <p role="alert">{t(error)}</p>}
    <a href="#/pair">{t(status === 'connected' ? 'reconnect' : 'pair')}</a>
  </div>;
}
function PairPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { store, status, error, root } = useConnection();
  const [url, setUrl] = useState(pairingFromLocation);
  const opened = useRef(false);
  async function pair(value: string) {
    setUrl('');
    clearPairingLocation();
    if (await store.pair(value)) window.location.hash = '/';
  }
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const value = pairingFromLocation();
    clearPairingLocation();
    if (value) void pair(value);
  }, []);
  return <FormPage title={t('pair')} subtitle={t('pairHelp')} onBack={onBack} saveLabel={t('pair')} saveDisabled={status === 'connecting' || !url.trim()} onSave={event => { event.preventDefault(); if (url.trim()) void pair(url.trim()); }}>
    <label className="field"><span>{t('pairUrl')}</span><input type="url" required autoComplete="off" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} /></label>
    <p role="status">{t(status)}{root ? ` · ${root}` : ''}</p>
    {error && <p role="alert">{t(error)}</p>}
  </FormPage>;
}
function Thinking() {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const start = Date.now(); const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000); return () => clearInterval(timer); }, []);
  return <p className="thinking-pill" role="status">{t('thinking')} · {seconds} {t('seconds')}</p>;
}
function TranscriptRow({ row }: { row: ChatRow }) {
  const { t, locale } = useI18n();
  if (row.kind === 'message') return row.text ? <article className={`message${row.role === 'user' ? ' message--own' : ''}`} data-streaming={!row.final || undefined}>
    <div className="message__body"><strong>{t(row.role === 'user' ? 'you' : 'botName')}</strong><p>{row.text}</p></div>
  </article> : null;
  if (row.kind === 'error') {
    const failure = localizedError({ code: row.code, message: row.text }, locale);
    return <p className="inline-error" role="alert">{failure.message}<br />{failure.hint} ({failure.code})</p>;
  }
  if (row.kind === 'tools') return <details key={String(row.finished)} className="event-card"><summary>{t(row.finished ? 'ranTools' : 'runningTools').replace('{count}', String(Object.keys(row.calls).length))}</summary><pre>{JSON.stringify(row.calls, null, 2)}</pre></details>;
  return <details className="event-card"><summary>{t('unknownEvent')}</summary><pre>{JSON.stringify(row.event, null, 2)}</pre></details>;
}
function ChatDetail({ sessionId, onBack, onOptions }: { sessionId: string; onBack: () => void; onOptions: () => void }) {
  const { t } = useI18n();
  const { store, status, root, sessions } = useConnection();
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChat);
  const [draft, setDraft] = useState('');
  const [ready, setReady] = useState(false);
  const { client } = store;
  const Send = icons.send, Options = icons.settings;
  useEffect(() => {
    if (!client || status !== 'connected') return;
    const controller = new AbortController();
    let ended = false;
    void (async () => {
      try {
        const subscription = await client.follow(sessionId, { signal: controller.signal });
        if (ended) { subscription.close(); return; }
        setReady(true);
        for await (const event of subscription) {
          if (ended) break;
          dispatch(event);
          if (event.type === 'turn-end') void store.refresh();
        }
        if (!ended) setReady(false);
      } catch { if (!ended) { setReady(false); dispatch({ type: 'error', sessionId, code: 'follow-failed', message: t('followFailed') }); } }
    })();
    return () => { ended = true; controller.abort(); };
  }, [client, sessionId, status, store]);
  function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !ready || !client) return;
    const text = draft.trim();
    setDraft('');
    dispatch({ type: 'waiting' });
    void client.sendMessage(sessionId, text).catch(() => { dispatch({ type: 'error', sessionId, code: 'send-failed', message: t('sendFailed') }); });
  }
  return <DetailPage title={sessions.find(s => s.sessionId === sessionId)?.title || t('untitledChat')} subtitle={root || t(status)} onBack={onBack} action={<Button variant="ghost" iconOnly aria-label={t('chatActions')} onClick={onOptions}><Options size={24} /></Button>}>
    <ConnectionStatus />
    <DeviceApprovals compact />
    <TransferCards compact />
    <LiveDeviceButton />
    <VirtualList items={state.rows} itemKey={row => row.id} label={t('messages')} followEnd className="transcript" renderItem={row => <TranscriptRow row={row} />} />
    <div className="composer-area glass">{state.waiting && <Thinking />}<p className="composer-notice">{t(state.waiting ? 'queueHelp' : 'sendHelp')}</p><form className="composer" onSubmit={send}>
      <textarea aria-label={t('composer')} placeholder={t('composer')} rows={2} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <Button type="submit" variant="primary" iconOnly disabled={!draft.trim() || !ready || status !== 'connected'} aria-label={t('send')}><Send size={24} /></Button>
    </form></div>
  </DetailPage>;
}
export function App() { return <DeviceHubProvider><AppContent /></DeviceHubProvider>; }
function AppContent() {
  const { t } = useI18n();
  const { reducedMotion } = useTheme();
  const { store, sessions, status } = useConnection();
  const [hash, setHash] = useState(() => typeof window === 'undefined' ? '#/' : window.location.hash);
  const [preferences, setPreferences] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const chatId = chatFromHash(hash);
  const pairing = hash.startsWith('#/pair');
  const devicesPage = hash.startsWith('#/devices');
  const transfersPage = hash.startsWith('#/transfers');
  const Settings = icons.settings, Avatar = icons.avatar;
  const visibleChats = sessions.filter(item => (item.title || t('untitledChat')).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const back = () => { window.location.hash = '/'; };
  useEffect(() => {
    const navigate = () => { setHash(window.location.hash); setSwipeOffset(0); };
    const shortcut = (event: KeyboardEvent) => { if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); back(); } };
    const refresh = () => { if (document.visibilityState === 'visible') void store.refresh(); };
    window.addEventListener('hashchange', navigate);
    window.addEventListener('keydown', shortcut);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('hashchange', navigate); window.removeEventListener('keydown', shortcut); document.removeEventListener('visibilitychange', refresh); };
  }, [store]);
  useEffect(() => { document.getElementById('main-content')?.focus({ preventScroll: true }); if (!chatId && !pairing) void store.refresh(); }, [hash, store]);
  async function newChat() {
    setCreating(true);
    try { const id = await store.newChat(); if (id) window.location.hash = `/chats/${encodeURIComponent(id)}`; }
    finally { setCreating(false); }
  }
  function startSwipe(event: PointerEvent<HTMLElement>) {
    if (chatId && window.innerWidth < breakpoints.tablet && event.clientX <= 32 && event.isPrimary) swipe.current = { x: event.clientX, y: event.clientY };
  }
  function moveSwipe(event: PointerEvent<HTMLElement>) {
    if (!swipe.current) return;
    if (Math.abs(event.clientY - swipe.current.y) > 48) { swipe.current = null; setSwipeOffset(0); return; }
    const distance = Math.max(0, event.clientX - swipe.current.x);
    if (distance > 8 && !event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    setSwipeOffset(distance);
  }
  function endSwipe() {
    if (swipeOffset > Math.min(120, window.innerWidth / 4)) back();
    swipe.current = null; setSwipeOffset(0);
  }
  return <div className="app-shell"><LanguageSync />
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>{t('skipToContent')}</a>
    <aside className="sidebar"><div className="sidebar__brand"><strong>{t('appName')}</strong><Button variant="ghost" iconOnly aria-label={t('openPreferences')} onClick={() => setPreferences(true)}><Settings size={24} /></Button></div>
      <p className="sidebar__caption">{t(isTauriRuntime() ? 'desktop' : 'web')}</p>
      <a className="devices-link" href="#/devices">{t("devices")}</a>
      <a className="devices-link" href="#/transfers">{t("transfers")}</a>
      <nav aria-label={t('chatNavigation')}><VirtualList items={sessions} itemKey={s => s.sessionId} label={t('chats')} renderItem={item => <ChatLink chat={item} selected={item.sessionId === chatId} />} /></nav>
    </aside>
    <main id="main-content" className="main-content" tabIndex={-1} onPointerDown={startSwipe} onPointerMove={moveSwipe} onPointerUp={endSwipe} onPointerCancel={() => { swipe.current = null; setSwipeOffset(0); }}>
      <div key={chatId ?? (pairing ? 'pair' : devicesPage ? 'devices' : 'hub')} className="route-view" data-direction={chatId ? 'forward' : 'back'} style={swipeOffset && !reducedMotion ? { transform: `translateX(${swipeOffset}px)`, animation: 'none' } as CSSProperties : undefined}>
        {transfersPage ? <TransfersPage onBack={back} /> : devicesPage ? <DevicesPage onBack={back} /> : pairing ? <PairPage onBack={back} /> : chatId ? <ChatDetail key={`${chatId}:${status}`} sessionId={chatId} onBack={back} onOptions={() => setPreferences(true)} /> : <HubPage title={t('chats')} subtitle={t('chatsSubtitle')} action={<Button variant="ghost" iconOnly aria-label={t('openPreferences')} onClick={() => setPreferences(true)}><Avatar size={24} /></Button>}>
          <ConnectionStatus />
          <a className="devices-link" href="#/devices">{t("devices")}</a>
      <a className="devices-link" href="#/transfers">{t("transfers")}</a>
          <DeviceApprovals compact />
    <TransferCards compact />
    <LiveDeviceButton />
          {status === 'connected' && <Button variant="primary" disabled={creating} onClick={() => void newChat()}>{t('newChat')}</Button>}
          <label className="search-field"><input type="search" value={query} placeholder={t('search')} aria-label={t('search')} onChange={event => setQuery(event.target.value)} /></label>
          {visibleChats.length ? <VirtualList items={visibleChats} itemKey={s => s.sessionId} label={t('chats')} renderItem={item => <ChatLink chat={item} />} /> : <p className="empty-state">{t(status === 'connected' ? 'noChats' : 'pairHelp')}</p>}
        </HubPage>}
      </div>
    </main>
    <Preferences open={preferences} onClose={() => setPreferences(false)} />
  </div>;
}
