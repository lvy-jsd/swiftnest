import type { SwiftnestClient, SwiftnestEvent } from '@swiftnest/api';

type ChatObserver = {
  ready: (ready: boolean) => void;
  event: (event: SwiftnestEvent) => void;
  failed: () => void;
};

/** A late callback from a replaced client must not clear the new client's readiness. */
export function readyClientAfter(
  current: SwiftnestClient | undefined,
  ready: boolean,
  client: SwiftnestClient,
): SwiftnestClient | undefined {
  if (ready) return client;
  return current === client ? undefined : current;
}

async function followChat(client: SwiftnestClient, sessionId: string, signal: AbortSignal, observer: ChatObserver) {
  const subscription = await client.follow(sessionId, { signal });
  try {
    if (signal.aborted) return;
    observer.ready(true);
    for await (const event of subscription) {
      if (signal.aborted) break;
      observer.event(event);
    }
  } finally {
    subscription.close();
  }
}

/** A session stream can end while the connection stays healthy. Re-follow without losing its draft or history. */
export function watchChatSession(client: SwiftnestClient, sessionId: string, observer: ChatObserver) {
  const controller = new AbortController();
  const { signal } = controller;
  let retry: ReturnType<typeof setTimeout>;
  let delay = 500;
  let reportedFailure = false;
  const activeObserver: ChatObserver = {
    ...observer,
    ready(ready) {
      if (signal.aborted) return;
      if (ready) {
        reportedFailure = false;
        delay = 500;
      }
      observer.ready(ready);
    },
  };
  async function follow() {
    try {
      await followChat(client, sessionId, signal, activeObserver);
    } catch {
      if (!signal.aborted && !reportedFailure) {
        reportedFailure = true;
        observer.failed();
      }
    }
    if (signal.aborted) return;
    activeObserver.ready(false);
    retry = setTimeout(() => void follow(), delay);
    delay = Math.min(delay * 2, 8000);
  }
  void follow();
  return () => {
    controller.abort();
    clearTimeout(retry);
  };
}
