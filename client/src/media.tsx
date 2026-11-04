import { useEffect, useState } from 'react';
import type { ChatAttachment, MessageImage } from '@swiftnest/api';
import { Card } from './components/Card';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { SendFile } from './transfers';

type AttachmentSource = { path: string } | { sessionId: string; image: MessageImage };

/** Both chat attachment stores share loading, cancellation and preview lifecycle. */
function useAttachment(source: AttachmentSource) {
  const { store, status } = useConnection();
  const { client } = store;
  const path = 'path' in source ? source.path : undefined;
  const sessionId = 'sessionId' in source ? source.sessionId : undefined;
  const image = 'image' in source ? source.image : undefined;
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    if (!client || status !== 'connected') return;
    const load =
      image && sessionId !== undefined
        ? client.readImage(sessionId, image)
        : client.downloadFile(path!, controller.signal);
    void load
      .then((value) => {
        if (controller.signal.aborted) return;
        if (typeof value === 'string') setUrl(value);
        else {
          objectUrl = URL.createObjectURL(value);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, status, path, sessionId, image]);
  return { url, failed };
}

function Preview({ url, name, image }: { url: string; name: string; image?: MessageImage }) {
  if (image || /\.(png|jpe?g|webp|gif)$/i.test(name))
    return (
      <img
        src={url || undefined}
        alt={name}
        width={image?.width}
        height={image?.height}
        className={image ? 'message-photo' : undefined}
        loading={image ? 'lazy' : undefined}
      />
    );
  if (url && /\.mp4$/i.test(name))
    return (
      <video src={url} controls aria-label={name}>
        <track kind="captions" />
      </video>
    );
  if (url && /\.wav$/i.test(name))
    return (
      <audio src={url} controls aria-label={name}>
        <track kind="captions" />
      </audio>
    );
  return null;
}

function Attachment({ file }: { file: ChatAttachment }) {
  const { t } = useI18n();
  const { url, failed } = useAttachment(file);
  return (
    <Card className="media-attachment">
      <strong>{file.name}</strong>
      {url && <Preview url={url} name={file.name} />}
      {failed && <p role="alert">{t('media.preview_failed')}</p>}
      {url && (
        <a href={url} download={file.name}>
          {t('media.download')}
        </a>
      )}
      <SendFile sourcePath={file.path} />
    </Card>
  );
}

function StoredPhoto({ sessionId, image }: { sessionId: string; image: MessageImage }) {
  const { t } = useI18n();
  const { url, failed } = useAttachment({ sessionId, image });
  if (failed) return <span className="photo-missing">{t('photoUnavailable')}</span>;
  return <Preview url={url} name={image.name ?? t('photo')} image={image} />;
}

/** Sent photos use the session store; generated media use the existing transfer store. */
export function MessagePhotos({ sessionId, images }: { sessionId: string; images?: readonly MessageImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="message-photos">
      {images.map((image) => (
        <StoredPhoto key={image.attachmentId} sessionId={sessionId} image={image} />
      ))}
    </div>
  );
}

export function ToolAttachments({
  calls,
}: {
  calls: Record<
    string,
    {
      name?: string;
      text?: string;
      attachments?: ChatAttachment[];
    }
  >;
}) {
  const { t } = useI18n();
  const values = Object.values(calls);
  const files = new Map(values.flatMap((call) => (call.attachments ?? []).map((file) => [file.path, file] as const)));
  return (
    <>
      {values.some(
        (call) => ['audio_transcribe', 'video_understand'].includes(call.name ?? '') && call.text === undefined,
      ) && <p role="status">{t('media.model_downloading')}</p>}
      {[...files.values()].map((file) => (
        <Attachment key={file.path} file={file} />
      ))}
    </>
  );
}
