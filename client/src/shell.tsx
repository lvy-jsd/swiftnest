import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@swiftnest/api';
import { Button } from './components/Button';
import { Chip } from './components/Chip';
import { IconButton } from './components/IconButton';
import { VirtualList } from './components/VirtualList';
import { useConnection } from './connection';
import { useDevices } from './devices';
import { icons } from './design/icons';
import { useI18n } from './i18n';
import { groupChats } from './shellState';
import { hasPrecisePointer } from './runtime';

export function BrandMark({ emblem = false }: { emblem?: boolean }) {
  const Nest = icons.brand;
  return (
    <span className={emblem ? 'brand-mark home-emblem' : 'brand-mark'}>
      <Nest size={emblem ? 32 : 20} weight="fill" aria-hidden="true" />
    </span>
  );
}

export function OnlineSummary() {
  const { devices, error } = useDevices();
  const { status } = useConnection();
  const { t } = useI18n();
  // The hub has no loaded flag. A nonempty successful snapshot is evidence; [] isn't.
  if (status !== 'connected' || error || !devices.length) return null;
  return (
    <span className="online-summary">
      {t('shell.devicesOnline').replace('{count}', String(devices.filter((device) => device.online).length))}
    </span>
  );
}

export function IdentityRow({ onPreferences }: { onPreferences: () => void }) {
  const { status, root, store } = useConnection();
  const { t } = useI18n();
  const Device = icons.device;
  const Settings = icons.settings;
  let name = t('shell.server');
  try {
    if (root) name = new URL(root).host;
  } catch {
    /* Use the generic name for an unavailable address. */
  }
  const encrypted = status === 'connected' && store.client?.connectionEncrypted === true;
  return (
    <footer className="identity-row">
      <Device size={24} aria-hidden="true" />
      <div className="identity-row__copy">
        <strong>{name}</strong>
        <p role="status" data-connected={status === 'connected'}>
          {t(status)}
          {encrypted ? ` · ${t('shell.encrypted')}` : ''}
        </p>
      </div>
      <IconButton aria-label={t('openPreferences')} onClick={onPreferences}>
        <Settings size={24} />
      </IconButton>
    </footer>
  );
}

export function ChatFilters({
  sessions,
  runningOnly,
  onChange,
}: {
  sessions: readonly SessionSummary[];
  runningOnly: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  if (!sessions.some((chat) => typeof chat.running === 'boolean')) return null;
  return (
    <fieldset className="chip-group" aria-label={t('shell.chatFilters')}>
      <Chip aria-label={t('shell.allChats')} selected={!runningOnly} onClick={() => onChange(false)}>
        {t('shell.allChats')}
      </Chip>
      <Chip aria-label={t('shell.runningChats')} selected={runningOnly} onClick={() => onChange(true)}>
        {t('shell.runningChats')} <span>{sessions.filter((chat) => chat.running).length}</span>
      </Chip>
    </fieldset>
  );
}

function ChatList({
  sessions,
  chatId,
  onNavigate,
}: {
  sessions: SessionSummary[];
  chatId?: string;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const items = groupChats(sessions).map((item, index, all) => ({
    ...item,
    startsGroup: index === 0 || all[index - 1]?.group !== item.group,
  }));
  return (
    <VirtualList
      items={items}
      itemKey={({ chat }) => chat.sessionId}
      label={t('chats')}
      renderItem={({ chat, group, startsGroup }) => {
        return (
          <>
            {startsGroup && <h2 className="chat-group-title">{t(group)}</h2>}
            <a
              className="chat-link"
              href={`#/chats/${encodeURIComponent(chat.sessionId)}`}
              onClick={onNavigate}
              aria-current={chat.sessionId === chatId ? 'page' : undefined}
            >
              <span>{chat.title || t('untitledChat')}</span>
              {chat.running === true && (
                <span className="chat-running-dot" role="img" aria-label={t('shell.runningChats')} />
              )}
            </a>
          </>
        );
      }}
    />
  );
}

function PrimaryNavigation({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useI18n();
  const links = [
    { route: 'devices', label: 'devices', Icon: icons.device },
    { route: 'transfers', label: 'shell.sendFiles', Icon: icons.transfer },
    { route: 'memory', label: 'memory', Icon: icons.memory },
  ] as const;
  return (
    <nav className="primary-navigation" aria-label={t('shell.navigation')}>
      {links.map(({ route, label, Icon }) => (
        <a key={route} href={`#/${route}`} onClick={onNavigate}>
          <Icon size={24} aria-hidden="true" />
          <span>{t(label)}</span>
          {route === 'devices' && <OnlineSummary />}
        </a>
      ))}
    </nav>
  );
}

function ChatSearch({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const { t } = useI18n();
  const Search = icons.search;
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (!search.current?.getClientRects().length) return;
      event.preventDefault();
      search.current.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  return (
    <label className="search-field">
      <Search size={20} aria-hidden="true" />
      <input
        ref={search}
        type="search"
        aria-label={t('search')}
        placeholder={t('search')}
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      {hasPrecisePointer() && (
        <kbd>
          {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
            ? t('shell.searchShortcutCommand')
            : t('shell.searchShortcutControl')}
        </kbd>
      )}
    </label>
  );
}

function BrandRow({ onNewChat }: { onNewChat: () => void }) {
  const { t } = useI18n();
  const { status } = useConnection();
  const Write = icons.write;
  return (
    <div className="sidebar__brand">
      <BrandMark />
      <strong>{t('appName')}</strong>
      {status === 'connected' && (
        <Button className="new-chat" variant="primary" onClick={onNewChat}>
          <Write size={16} aria-hidden="true" />
          {t('newChat')}
        </Button>
      )}
    </div>
  );
}

export function Sidebar({
  chatId,
  onNewChat,
  onNavigate,
  onPreferences,
}: {
  chatId?: string;
  onNewChat: () => void;
  onNavigate: () => void;
  onPreferences: () => void;
}) {
  const { t } = useI18n();
  const { sessions } = useConnection();
  const [query, setQuery] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);
  const visible = sessions.filter(
    (chat) =>
      (!runningOnly || chat.running === true) &&
      (chat.title || t('untitledChat')).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="sidebar-content">
      <BrandRow onNewChat={onNewChat} />
      <ChatSearch query={query} onChange={setQuery} />
      <PrimaryNavigation onNavigate={onNavigate} />
      <ChatFilters sessions={sessions} runningOnly={runningOnly} onChange={setRunningOnly} />
      <nav className="chat-navigation" aria-label={t('chatNavigation')}>
        {visible.length ? (
          <ChatList sessions={visible} chatId={chatId} onNavigate={onNavigate} />
        ) : (
          <p className="sidebar-empty">{t('noChats')}</p>
        )}
      </nav>
      <IdentityRow onPreferences={onPreferences} />
    </div>
  );
}
