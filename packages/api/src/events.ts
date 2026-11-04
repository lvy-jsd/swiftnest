import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types';
import type { MessageImage, SwiftnestEvent } from './types.js';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = record(block);
      return b.type === 'text' ? String(b.text ?? '') : '';
    })
    .join('');
}

function mediaAttachments(value: unknown): import('./types.js').ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const file = record(item);
    if (
      typeof file.path !== 'string' ||
      typeof file.name !== 'string' ||
      !/^media\/[\p{L}\p{N}_-]+\.(png|jpe?g|webp|gif|mp4|wav|mid|srt)$/u.test(file.path)
    )
      return [];
    return [{ path: file.path, name: file.name }];
  });
}

function toolResult(data: Record<string, unknown>) {
  const message = record(data.message);
  const files = record(data.meta).mediaFiles;
  return {
    type: 'tool-result' as const,
    callId: String(message.toolCallId),
    text: text(message.content),
    isError: message.isError === true,
    ...(Array.isArray(files) ? { attachments: mediaAttachments(files) } : {}),
  };
}

/** Stored image references in a user message; DSH replaces uploaded bytes with these. */
function images(content: unknown): MessageImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const b = record(block);
    const ref = record(b.attachment ?? b);
    if (b.type !== 'image' || typeof ref.attachmentId !== 'string') return [];
    return [
      {
        attachmentId: ref.attachmentId,
        mediaType: String(ref.mediaType ?? 'image/png'),
        ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
        ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
        ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
      },
    ];
  });
}

/** Translate only chat presentation events; unknown kernel bookkeeping is intentionally ignored. */
export function mapEvent(sessionId: string, event: SessionWireEvent): SwiftnestEvent[] {
  const base = { sessionId, seq: event.seq, time: event.time };
  const data = record(event.data);
  const message = record(data.message);
  switch (event.type) {
    case 'user/message':
      // DSH also logs runtime/time context with the user role. Only human
      // prompts belong in the App's chat transcript.
      if (record(data.source).kind !== 'user') return [];
      return [
        {
          ...base,
          type: 'user-message',
          messageId: String(data.id),
          text: text(data.content),
          ...(images(data.content).length ? { images: images(data.content) } : {}),
          ...(typeof record(data.source).rpcId === 'string' ? { requestId: record(data.source).rpcId as string } : {}),
        },
      ];
    case 'assistant/message':
      return [{ ...base, type: 'assistant-message', messageId: String(message.id), text: text(message.content) }];
    case 'tool/call':
      return [
        {
          ...base,
          type: 'tool-start',
          callId: String(data.callId),
          name: String(data.name),
          arguments: String(data.arguments),
        },
      ];
    case 'tool/result':
      return [{ ...base, ...toolResult(data) }];
    case 'turn/end': {
      const reason = record(data.reason);
      const result: SwiftnestEvent[] = [];
      if (reason.kind === 'error') {
        const error = record(reason.error);
        result.push({
          ...base,
          type: 'error',
          code: String(error.code ?? 'model-error'),
          message: String(error.message ?? 'Model request failed'),
        });
      }
      result.push({ ...base, type: 'turn-end', turn: Number(data.turn), reason: String(reason.kind) });
      return result;
    }
    default:
      return [];
  }
}

export function mapFrame(sessionId: string, frame: SessionFollowFrame): SwiftnestEvent[] {
  if (frame.type === 'event') return mapEvent(sessionId, frame.event);
  if (frame.type === 'snapshot') {
    const events = frame.records.flatMap((entry) => mapEvent(sessionId, entry.event));
    // An opening snapshot can catch an attempt already in progress. Replay its text
    // as one delta; subsequent chunk indices start at nextIndex, without duplicating it.
    const attempt = frame.assistantStream?.activeAttempt;
    if (attempt) {
      events.push({ sessionId, type: 'assistant-start', attemptId: attempt.attemptId });
      let accumulated = '';
      for (const entry of attempt.stream) {
        const value = record(entry);
        if (value.type === 'text-chunks' && Array.isArray(value.texts)) accumulated += value.texts.join('');
        if (value.type === 'chunk') {
          const chunk = record(value.chunk);
          if (chunk.type === 'text-delta') accumulated += String(chunk.text ?? '');
        }
      }
      if (accumulated)
        events.push({
          sessionId,
          type: 'assistant-delta',
          attemptId: attempt.attemptId,
          index: attempt.nextIndex - 1,
          text: accumulated,
        });
    }
    return events;
  }
  const f = frame.frame;
  if (f.type === 'start') return [{ sessionId, type: 'assistant-start', attemptId: f.attemptId }];
  if (f.type === 'end')
    return [
      {
        sessionId,
        type: 'assistant-end',
        attemptId: f.attemptId,
        outcome: f.outcome.kind,
        ...(f.outcome.kind === 'committed' && f.outcome.eventType === 'assistant/message'
          ? { messageSeq: f.outcome.seq }
          : {}),
      },
    ];
  const chunk = record(f.chunk);
  return chunk.type === 'text-delta'
    ? [
        {
          sessionId,
          type: 'assistant-delta',
          attemptId: f.attemptId,
          index: f.index,
          time: f.time,
          text: String(chunk.text ?? ''),
        },
      ]
    : [];
}
