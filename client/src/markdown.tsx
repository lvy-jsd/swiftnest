import { memo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from './i18n';
import './markdown.css';

/** Model output may link out, but cannot invoke App protocols or fetch images by itself. */
function linkUrl(url: string): string | undefined {
  return /^(https?:|mailto:)/i.test(url) ? url : undefined;
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const { t } = useI18n();
  const code = useRef<HTMLPreElement>(null);
  const [result, setResult] = useState<{ source: ReactNode; status: 'copied' | 'failed' }>();
  const status = result && result.source === children ? result.status : 'idle';
  async function copy() {
    try {
      await navigator.clipboard.writeText(code.current?.textContent ?? '');
      setResult({ source: children, status: 'copied' });
    } catch {
      setResult({ source: children, status: 'failed' });
    }
  }
  return (
    <div className="markdown-code">
      <div className="markdown-code__header">
        <span>{t('chat.code')}</span>
        <button type="button" onClick={() => void copy()}>
          {t(status === 'copied' ? 'chat.codeCopied' : 'chat.copyCode')}
        </button>
      </div>
      <pre ref={code}>{children}</pre>
      {status === 'failed' && <p role="status">{t('chat.copyFailed')}</p>}
    </div>
  );
}

function Link({ href, children }: ComponentProps<'a'>) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function ImageLink({ src, alt }: ComponentProps<'img'>) {
  const { t } = useI18n();
  return <Link href={typeof src === 'string' ? src : undefined}>{alt || t('chat.imageLink')}</Link>;
}

function Table({ children }: ComponentProps<'table'>) {
  const { t } = useI18n();
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Wide tables must be scrollable with the keyboard.
    <section className="markdown-table" aria-label={t('chat.table')} tabIndex={0}>
      <table>{children}</table>
    </section>
  );
}

const components = { pre: CodeBlock, a: Link, img: ImageLink, table: Table };
const plugins = [remarkGfm];

export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={plugins} components={components} urlTransform={linkUrl} skipHtml>
        {text}
      </Markdown>
    </div>
  );
});
