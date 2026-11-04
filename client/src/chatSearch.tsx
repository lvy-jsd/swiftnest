import { useEffect, useState } from 'react';
import { localizedError, type ChatSearchResult } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { VirtualList } from './components/VirtualList';

export function ResultSnippet({ result }: { result: ChatSearchResult }) {
  const pieces = [];
  let offset = 0;
  for (const [start, end] of result.highlights) {
    pieces.push(result.snippet.slice(offset, start));
    pieces.push(<mark key={start}>{result.snippet.slice(start, end)}</mark>);
    offset = end;
  }
  pieces.push(result.snippet.slice(offset));
  return <span className="chat-search-snippet">{pieces}</span>;
}
function SearchResult({ result }: { result: ChatSearchResult }) {
  const { t, locale } = useI18n();
  return (
    <a className="chat-link" href={`#/chats/${encodeURIComponent(result.sessionId)}`}>
      <span className="chat-link__copy">
        <strong>{result.title || t('untitledChat')}</strong>
        <ResultSnippet result={result} />
        <time dateTime={new Date(result.time).toISOString()}>{new Date(result.time).toLocaleString(locale)}</time>
      </span>
    </a>
  );
}
function useChatSearch(query: string) {
  const { store, status } = useConnection();
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setResults([]);
    setBusy(true);
    setError(undefined);
    const timer = setTimeout(() => {
      if (!store.client || status !== 'connected') {
        setBusy(false);
        return;
      }
      void store.client
        .searchChats(query, 20, abort.signal)
        .then(
          (results) => {
            if (!abort.signal.aborted) setResults(results);
          },
          (error) => {
            if (!abort.signal.aborted) setError(error);
          },
        )
        .finally(() => {
          if (!abort.signal.aborted) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, store, status]);
  return { results, error, busy };
}
export function ChatSearchResults({ query }: { query: string }) {
  const { t } = useI18n();
  const { results, error, busy } = useChatSearch(query);
  if (error) return <p role="alert">{localizedError(error).message}</p>;
  if (busy) return <p role="status">{t('chatSearchSearching')}</p>;
  if (!results.length) return <p role="status">{t('chatSearchEmpty')}</p>;
  return (
    <VirtualList
      items={results}
      itemKey={(row) => row.id}
      label={t('chatSearchResults')}
      renderItem={(result) => <SearchResult result={result} />}
    />
  );
}
