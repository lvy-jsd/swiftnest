import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent } from "react";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { DetailPage, HubPage, SheetPage } from "./components/pages";
import { VirtualList } from "./components/VirtualList";
import { icons } from "./design/icons";
import { presets } from "./design/palette";
import { useTheme } from "./design/theme";
import type { ThemePreference } from "./design/theme";
import { breakpoints } from "./design/tokens";
import { useI18n } from "./i18n";
import type { Locale, StringKey } from "./i18n";
import { isTauriRuntime } from "./runtime";

type Chat = { id: string; title: StringKey; preview: StringKey; message: StringKey };
const chats: readonly Chat[] = [
  { id: "fresh-start", title: "sampleTitle", preview: "samplePreview", message: "welcomeMessage" },
  { id: "weekend", title: "secondTitle", preview: "secondPreview", message: "secondMessage" },
];
type Message = { id: string; text: string };
export function chatFromHash(hash: string): Chat | undefined {
  return chats.find(chat => hash === `#/chats/${chat.id}`);
}

function Preferences({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const theme = useTheme();
  const chosenPreset = Object.entries(presets).find(([, hue]) => hue === theme.accentHue)?.[0] ?? "custom";
  return <SheetPage open={open} onClose={onClose} title={t("preferences")} actions={<Button variant="primary" onClick={onClose}>{t("done")}</Button>}>
    <div className="field-groups">
      <label className="field"><span>{t("language")}</span><select value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="en">{t("english")}</option><option value="zh-CN">{t("chinese")}</option></select></label>
      <label className="field"><span>{t("appearance")}</span><select value={theme.preference} onChange={event => theme.setPreference(event.target.value as ThemePreference)}>{(["system", "light", "dark"] as const).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
      <label className="field"><span>{t("accent")}</span><select value={chosenPreset} onChange={event => theme.setAccentHue(event.target.value === "custom" ? 0 : presets[event.target.value as keyof typeof presets])}>{Object.keys(presets).map(name => <option key={name} value={name}>{t(name as keyof typeof presets)}</option>)}<option value="custom">{t("custom")}</option></select></label>
      <label className="field"><span>{t("customHue")}</span><input type="range" min={0} max={359} step={1} value={theme.accentHue} onChange={event => theme.setAccentHue(Number(event.target.value))} /></label>
      <label className="switch-field"><span>{t("reduceMotion")}</span><input type="checkbox" checked={theme.reduceMotion} onChange={event => theme.setReduceMotion(event.target.checked)} /></label>
      <label className="switch-field"><span>{t("reduceTransparency")}</span><input type="checkbox" checked={theme.reduceTransparency} onChange={event => theme.setReduceTransparency(event.target.checked)} /></label>
    </div>
  </SheetPage>;
}

function ChatLink({ chat, selected = false }: { chat: Chat; selected?: boolean }) {
  const { t } = useI18n();
  const ChatIcon = icons.chat;
  return <a className="chat-link" href={`#/chats/${chat.id}`} aria-current={selected ? "page" : undefined}>
    <span className="avatar"><ChatIcon size={24} weight={selected ? "fill" : "regular"} aria-hidden="true" /></span>
    <span className="chat-link__copy"><strong>{t(chat.title)}</strong><span>{t(chat.preview)}</span></span>
  </a>;
}

function ChatDetail({ chat, messages, onSend, onBack, onOptions }: { chat: Chat; messages: readonly Message[]; onSend: (text: string) => void; onBack: () => void; onOptions: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const Send = icons.send, Options = icons.settings, Avatar = icons.avatar;
  const transcript = [{ id: "welcome", text: t(chat.message), name: t("botName"), own: false }, ...messages.map(message => ({ ...message, name: t("you"), own: true }))];
  function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft("");
  }
  return <DetailPage title={t(chat.title)} subtitle={t("sampleSubtitle")} onBack={onBack} action={<Button variant="ghost" iconOnly aria-label={t("chatActions")} onClick={onOptions}><Options size={24} /></Button>}>
    <VirtualList items={transcript} itemKey={message => message.id} label={t("messages")} followEnd className="transcript" renderItem={message => <article className={`message${message.own ? " message--own" : ""}`}>
      <span className="avatar" aria-hidden="true"><Avatar size={24} /></span><div className="message__body"><strong>{message.name}</strong><p>{message.text}</p></div>
    </article>} />
    <div className="composer-area glass"><p className="sample-notice">{t("sampleNotice")}</p><form className="composer" onSubmit={send}>
      <textarea aria-label={t("composer")} placeholder={t("composer")} rows={2} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <Button type="submit" variant="primary" iconOnly disabled={!draft.trim()} aria-label={t("send")}><Send size={24} /></Button>
    </form></div>
  </DetailPage>;
}

export function App() {
  const { t } = useI18n();
  const { reducedMotion } = useTheme();
  const [hash, setHash] = useState(() => typeof window === "undefined" ? "#/" : window.location.hash);
  const [preferences, setPreferences] = useState(false);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [query, setQuery] = useState("");
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const nextMessageId = useRef(0);
  const chat = chatFromHash(hash);
  const Settings = icons.settings, Avatar = icons.avatar;
  const visibleChats = chats.filter(item => `${t(item.title)} ${t(item.preview)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const back = () => { window.location.hash = "/"; };
  useEffect(() => {
    const navigate = () => { setHash(window.location.hash); setSwipeOffset(0); };
    const shortcut = (event: KeyboardEvent) => { if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); back(); } };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("keydown", shortcut);
    return () => { window.removeEventListener("hashchange", navigate); window.removeEventListener("keydown", shortcut); };
  }, []);
  useEffect(() => { document.getElementById("main-content")?.focus({ preventScroll: true }); }, [hash]);

  function send(text: string) {
    if (!chat) return;
    // TODO: connect @swiftnest/api here. Keep the composer enabled during generation;
    // offer Send now / Queue when a real turn is running (design-system §9).
    const id = String(++nextMessageId.current);
    setMessages(previous => ({ ...previous, [chat.id]: [...(previous[chat.id] ?? []), { id, text }] }));
  }
  function startSwipe(event: PointerEvent<HTMLElement>) {
    if (chat && window.innerWidth < breakpoints.tablet && event.clientX <= 32 && event.isPrimary) swipe.current = { x: event.clientX, y: event.clientY };
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
    swipe.current = null;
    setSwipeOffset(0);
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>{t("skipToContent")}</a>
    <aside className="sidebar"><div className="sidebar__brand"><strong>{t("appName")}</strong><Button variant="ghost" iconOnly aria-label={t("openPreferences")} onClick={() => setPreferences(true)}><Settings size={24} /></Button></div>
      <p className="sidebar__caption">{t(isTauriRuntime() ? "desktop" : "web")}</p>
      <nav aria-label={t("chatNavigation")}>{chats.map(item => <ChatLink key={item.id} chat={item} selected={item.id === chat?.id} />)}</nav>
    </aside>
    <main id="main-content" className="main-content" tabIndex={-1} onPointerDown={startSwipe} onPointerMove={moveSwipe} onPointerUp={endSwipe} onPointerCancel={() => { swipe.current = null; setSwipeOffset(0); }}>
      <div key={chat?.id ?? "hub"} className="route-view" data-direction={chat ? "forward" : "back"} style={swipeOffset && !reducedMotion ? { transform: `translateX(${swipeOffset}px)`, animation: "none" } as CSSProperties : undefined}>
        {chat ? <ChatDetail key={chat.id} chat={chat} messages={messages[chat.id] ?? []} onSend={send} onBack={back} onOptions={() => setPreferences(true)} /> : <HubPage title={t("chats")} subtitle={t("chatsSubtitle")} action={<Button variant="ghost" iconOnly aria-label={t("openPreferences")} onClick={() => setPreferences(true)}><Avatar size={24} /></Button>}>
          <section className="chat-group" aria-label={t("localOnly")}><h2>{t("localOnly")}</h2><label className="search-field"><input type="search" value={query} placeholder={t("search")} aria-label={t("search")} onChange={event => setQuery(event.target.value)} /></label>
            {visibleChats.length ? visibleChats.map(item => <Card key={item.id}><ChatLink chat={item} /></Card>) : <p className="empty-state">{t("noChats")}</p>}
          </section>
        </HubPage>}
      </div>
    </main>
    <Preferences open={preferences} onClose={() => setPreferences(false)} />
  </div>;
}
