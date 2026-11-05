import { localizedError, type SessionSummary, type ChatSearchResult } from '@swiftnest/api';
import { useI18n } from './i18n';
import { VirtualList } from './components/VirtualList';
import { ResultSnippet, useChatSearch } from './chatSearch';
import { groupChats } from './shellState';

type ChatItem = SessionSummary & { result?: ChatSearchResult };
type ChatListProps = {
  sessions: readonly ChatItem[];
  chatId?: string;
  onNavigate: () => void;
};

/** Normal chats and historical matches share the shell's compact grouped rows. */
export function ChatList({ sessions, chatId, onNavigate }: ChatListProps) {
  const { t } = useI18n();
  const searching = sessions.some((chat) => chat.result);
  const items = groupChats(sessions).map((item, index, all) => ({
    ...item,
    startsGroup: index === 0 || all[index - 1]?.group !== item.group,
  }));
  return (
    <VirtualList
      items={items}
      itemKey={({ chat }) => chat.result?.id ?? chat.sessionId}
      label={t(searching ? 'chatSearchResults' : 'chats')}
      renderItem={({ chat, group, startsGroup }) => (
        <>
          {startsGroup && <h2 className="chat-group-title">{t(group)}</h2>}
          <ChatLink chat={chat} selected={chat.sessionId === chatId} onNavigate={onNavigate} />
        </>
      )}
    />
  );
}

function ChatLink({ chat, selected, onNavigate }: { chat: ChatItem; selected: boolean; onNavigate: () => void }) {
  const { t, locale } = useI18n();
  return (
    <a
      className="chat-link"
      href={`#/chats/${encodeURIComponent(chat.sessionId)}`}
      onClick={onNavigate}
      aria-current={selected ? 'page' : undefined}
    >
      <span>
        {chat.title || t('untitledChat')}
        {chat.result && (
          <>
            <ResultSnippet result={chat.result} />
            <time dateTime={new Date(chat.result.time).toISOString()}>
              {new Date(chat.result.time).toLocaleString(locale)}
            </time>
          </>
        )}
      </span>
      {chat.running === true && <span className="chat-running-dot" role="img" aria-label={t('shell.runningChats')} />}
    </a>
  );
}

export function ChatSearchResults({
  query,
  sessions,
  runningOnly,
  ...navigation
}: ChatListProps & { query: string; runningOnly: boolean }) {
  const { t } = useI18n();
  const { results, error, busy } = useChatSearch(query);
  const chats = results
    .map((result) => ({
      running: false,
      blank: false,
      ...sessions.find((chat) => chat.sessionId === result.sessionId),
      sessionId: result.sessionId,
      title: result.title,
      updatedAt: result.time,
      result,
    }))
    .filter((chat) => !runningOnly || chat.running === true);
  if (error) return <p role="alert">{localizedError(error).message}</p>;
  if (busy) return <p role="status">{t('chatSearchSearching')}</p>;
  if (!chats.length) return <p role="status">{t('chatSearchEmpty')}</p>;
  return <ChatList sessions={chats} {...navigation} />;
}
