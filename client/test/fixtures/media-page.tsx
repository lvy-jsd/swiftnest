import { ApprovalInboxProvider } from '../../src/inboxState';
/** Browser-only fixture: render the real attachment and transfer components. */
import { createRoot } from 'react-dom/client';
import type { SwiftnestClient } from '@swiftnest/api';
import { MessagePhotos, ToolAttachments } from '../../src/media';
import { DeviceHubProvider } from '../../src/devices';
import { ConnectionProvider, ConnectionStore } from '../../src/connection';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/design/theme';
import '../../src/styles.css';

const requests: unknown[] = [];
(window as any).requests = requests;
const client = {
  connect: async () => {},
  listSessions: async () => [],
  listDevices: async () => [
    { device: 'phone', slug: 'phone', name: 'Phone', paired: true, online: true, capabilities: [] },
  ],
  approvalInbox: async () => ({
    items: [],
    settings: { remind: true, autoAllowLowRisk: false, timeouts: { dsh: 600000, device: 600000, transfer: 600000 } },
  }),
  listDevicePairings: async () => [],
  listTransfers: async () => [],
  watchApprovals: async () => ({ async *[Symbol.asyncIterator]() {}, close() {} }),
  watchDevices: async () => ({
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  }),
  downloadFile: async (path: string) => {
    requests.push(path);
    const types: Record<string, string> = {
      png: 'image/png',
      gif: 'image/gif',
      mp4: 'video/mp4',
      wav: 'audio/wav',
      srt: 'application/x-subrip',
    };
    const type = types[path.split('.').at(-1)!] ?? 'application/octet-stream';
    return new Blob(['fixture'], { type });
  },
  readImage: async (
    sessionId: string,
    image: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string },
  ) => {
    // Mirror the kernel: the App must send the complete stored reference back.
    requests.push({ sessionId, attachment: { ...image } });
    if (image.attachmentId === 'missing') throw new Error('Missing photo');
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  },
  startTransfer: async (request: unknown) => requests.push(request),
  close() {},
} as unknown as SwiftnestClient;
const store = new ConnectionStore(
  async () => ({ cookieMode: 'browser' }),
  () => client,
);
await store.pair(`${location.origin}/connect?token=test`);
const locale = new URL(location.href).searchParams.get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
const files = ['chart.png', 'video.mp4', 'music.wav', 'subtitles.srt', 'animation.gif'];
const calls = {
  render: { name: 'video_render', text: 'done', attachments: files.map((name) => ({ path: `media/${name}`, name })) },
  chart: { name: 'chart_render', text: 'done', attachments: [{ path: 'media/chart.png', name: 'chart.png' }] },
  speech: { name: 'audio_transcribe' },
};
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider initialLocale={locale}>
      <ConnectionProvider store={store}>
        <DeviceHubProvider>
          <ApprovalInboxProvider>
            <MessagePhotos
              sessionId="photos"
              images={[
                { attachmentId: 'stored', mediaType: 'image/png', name: 'sent.png', bytes: 68, width: 1, height: 1 },
                { attachmentId: 'missing', mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
              ]}
            />
            <ToolAttachments calls={calls} />
          </ApprovalInboxProvider>
        </DeviceHubProvider>
      </ConnectionProvider>
    </I18nProvider>
  </ThemeProvider>,
);
