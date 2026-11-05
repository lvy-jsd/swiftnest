import { useEffect, useState } from 'react';
import type { ChatSearchResult } from '@swiftnest/api';
import { useConnection } from './connection';

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
export function useChatSearch(query: string) {
  const { store, status } = useConnection();
  const client = store.client;
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setResults([]);
    setBusy(true);
    setError(undefined);
    const timer = setTimeout(() => {
      if (!client || status !== 'connected') {
        setBusy(false);
        return;
      }
      void client
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
  }, [query, client, status]);
  return { results, error, busy };
}
