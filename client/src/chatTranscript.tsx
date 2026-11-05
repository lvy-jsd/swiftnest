import { localizedError } from '@swiftnest/api';
import type { ChatRow } from './chat';
import { messageTime, toolSeconds, type ChatTimeline } from './chatPresentation';
import { ApprovalCard } from './approvals';
import { ChatIcon } from './components/ChatIcon';
import { useComposerDraft } from './composer';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { MessagePhotos, ToolAttachments } from './media';

function Message({
  row,
  sessionId,
  timeline,
}: {
  row: Extract<ChatRow, { kind: 'message' }>;
  sessionId: string;
  timeline: ChatTimeline;
}) {
  const { t, locale } = useI18n();
  const { assistantName } = useConnection();
  if (!row.text && !row.images?.length) return null;
  const time = messageTime(row, timeline);
  const date = time === undefined ? undefined : new Date(time);
  return (
    <article
      className={`message${row.role === 'user' ? ' message--own' : ''}`}
      data-streaming={!row.final || undefined}
    >
      <div className="message__meta">
        <strong>{row.role === 'user' ? t('you') : (assistantName ?? t('assistant'))}</strong>
        <span aria-hidden="true">·</span>
        {date ? (
          <time dateTime={date.toISOString()} title={date.toLocaleString(locale)}>
            {date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })}
          </time>
        ) : (
          <span>{t('chat.timeUnavailable')}</span>
        )}
      </div>
      <div className="message__body">
        <MessagePhotos sessionId={sessionId} images={row.images} />
        {row.text && <p>{row.text}</p>}
      </div>
    </article>
  );
}

function ToolTrace({ row, timeline }: { row: Extract<ChatRow, { kind: 'tools' }>; timeline: ChatTimeline }) {
  const { t } = useI18n();
  const failed = Object.values(row.calls).some((call) => call.isError);
  const seconds = toolSeconds(row, timeline);
  const label = row.finished ? (failed ? 'chat.stepsFinishedWithErrors' : 'chat.stepsCompleted') : 'chat.stepsRunning';
  return (
    <div className="tool-delivery">
      <details key={String(row.finished)} className="event-card tool-trace">
        <summary>
          <ChatIcon name={row.finished && !failed ? 'check' : 'clock'} />
          <span>{t(label).replace('{count}', String(Object.keys(row.calls).length))}</span>
          {row.finished && seconds !== undefined && (
            <span className="tool-trace__duration">
              · {seconds} {t('seconds')}
            </span>
          )}
          <ChatIcon name="chevron" />
        </summary>
        <pre>{JSON.stringify(row.calls, null, 2)}</pre>
      </details>
      <ToolAttachments calls={row.calls} />
    </div>
  );
}

export function TranscriptRow({
  row,
  sessionId,
  timeline,
}: {
  row: ChatRow;
  sessionId: string;
  timeline: ChatTimeline;
}) {
  const { t, locale } = useI18n();
  if (row.kind === 'message') return <Message row={row} sessionId={sessionId} timeline={timeline} />;
  if (row.kind === 'approval') return <ApprovalCard request={row} />;
  if (row.kind === 'tools') return <ToolTrace row={row} timeline={timeline} />;
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
  return (
    <details className="event-card">
      <summary>{t('unknownEvent')}</summary>
      <pre>{JSON.stringify(row.event, null, 2)}</pre>
    </details>
  );
}

export function EmptyChat({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const { setText } = useComposerDraft(sessionId);
  return (
    <div className="chat-empty">
      <ChatIcon name="chat" />
      <h2>{t('chat.emptyTitle')}</h2>
      <p>{t('chat.emptyHelp')}</p>
      <div className="chat-empty__suggestions">
        {(['home.plan', 'home.explain'] as const).map((key) => (
          <button
            type="button"
            key={key}
            onClick={() => {
              setText(t(key));
              document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus();
            }}
          >
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
}
