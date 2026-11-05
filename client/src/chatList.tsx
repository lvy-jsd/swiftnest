import { useState } from 'react';
import type { SessionSummary } from '@swiftnest/api';
import { useConnection } from './connection';
import { usePlugins } from './plugins';
import { useI18n } from './i18n';
import { icons } from './design/icons';
import { VirtualList } from './components/VirtualList';
import { ChatSearchResults } from './chatSearch';

/** Each visible chat list owns its query, including the desktop sidebar on other pages. */
export function ChatList({ selected }: { selected?: string }) {
  const { sessions, status } = useConnection();
  const { owner } = usePlugins();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const Search = icons.search;
  const visible = sessions.filter((item) =>
    (item.title || t('untitledChat')).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <label className="search-field">
        <Search size={24} aria-hidden="true" />
        <input
          type="search"
          value={query}
          maxLength={1024}
          placeholder={t('search')}
          aria-label={t('search')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim() && owner && status === 'connected' ? (
        <ChatSearchResults query={query} />
      ) : visible.length ? (
        <VirtualList
          items={visible}
          itemKey={(item) => item.sessionId}
          label={t('chats')}
          renderItem={(item) => <ChatLink chat={item} selected={item.sessionId === selected} />}
        />
      ) : (
        <p className="empty-state">{t(status === 'connected' ? 'noChats' : 'pairHelp')}</p>
      )}
    </>
  );
}

function ChatLink({ chat, selected = false }: { chat: SessionSummary; selected?: boolean }) {
  const { t, locale } = useI18n();
  const ChatIcon = icons.chat;
  return (
    <a
      className="chat-link"
      href={`#/chats/${encodeURIComponent(chat.sessionId)}`}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="avatar">
        <ChatIcon size={24} weight="regular" aria-hidden="true" />
      </span>
      <span className="chat-link__copy">
        <strong>{chat.title || t('untitledChat')}</strong>
        <time dateTime={new Date(chat.updatedAt).toISOString()}>{new Date(chat.updatedAt).toLocaleString(locale)}</time>
      </span>
    </a>
  );
}
