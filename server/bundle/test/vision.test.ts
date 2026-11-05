import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Llm, LlmRequest } from '../src/llm.js';
import { apply, type VisionConfig, type VisionContext } from '../src/vision.js';
import { freeDescriber, routeDescriber } from '../src/vision-services.js';

const photo = { attachmentId: 'a1', mediaType: 'image/jpeg', width: 640, height: 480, name: 'cat.jpg' };
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(freeVision?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'swiftnest-vision-'));
  homes.push(dir);
  if (freeVision) writeFileSync(join(dir, 'models.json'), JSON.stringify({ freeVision }));
  return dir;
}

type Listener = Parameters<VisionContext['on']>[1];

/** A fake kernel: `vision/*` routes describe, the main route records what it was sent. */
function kernel(describe: (provider: string) => string | Error = () => 'A grey cat on a sofa.') {
  const sent: unknown[] = [];
  const asked: string[] = [];
  let listener: Listener | undefined;
  async function* reply(text: string) {
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const ctx: VisionContext = {
    llm: {
      stream(options) {
        if (options.provider === 'main') {
          const through = listener!(options as Parameters<Listener>[0], () => {
            sent.push(options.messages);
            return reply('ok');
          });
          return through;
        }
        asked.push(options.provider);
        const answer = describe(options.provider);
        if (answer instanceof Error) {
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: answer.message } } };
          })();
        }
        return reply(answer);
      },
    },
    attachments: { readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }) },
    on: (_event, fn) => {
      listener = fn;
      return () => {};
    },
    effect: (fn) => {
      fn();
    },
  };
  return { ctx, sent, asked };
}

function config(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    provider: 'main',
    services: [{ provider: 'vision-a', model: 'eye' }],
    free: { baseUrl: 'http://127.0.0.1:9/v1', models: ['free-eye'] },
    home: home(),
    ...overrides,
  };
}

const message = {
  role: 'user',
  content: [
    { type: 'image', attachment: photo },
    { type: 'text', text: 'What animal is this?' },
  ],
};

async function call(ctx: VisionContext, messages: unknown[] = [message]) {
  for await (const _ of ctx.llm.stream({ provider: 'main', model: 'm', messages: messages as never })) {
    // drain
  }
}

function textOf(sent: unknown[]): string {
  return JSON.stringify(sent.at(-1));
}

it('swaps a photo for a description from the owner’s vision model, and describes it only once', async () => {
  const test = kernel();
  apply(test.ctx, config());
  await call(test.ctx);
  await call(test.ctx);
  expect(textOf(test.sent)).toContain('A grey cat on a sofa.');
  expect(textOf(test.sent)).toContain('What animal is this?');
  expect(textOf(test.sent)).not.toContain('"image"');
  expect(test.asked).toEqual(['vision-a']);
});

it('tries the next service when one fails', async () => {
  const test = kernel((provider) => (provider === 'vision-a' ? new Error('quota') : 'A cat.'));
  apply(
    test.ctx,
    config({
      services: [
        { provider: 'vision-a', model: 'eye' },
        { provider: 'vision-b', model: 'eye' },
      ],
    }),
  );
  await call(test.ctx);
  expect(test.asked).toEqual(['vision-a', 'vision-b']);
  expect(textOf(test.sent)).toContain('A cat.');
});

it('passes the photo, question and cancellation through the shared Llm request', async () => {
  const requests: LlmRequest[] = [];
  const llm: Llm = {
    async *stream(request) {
      requests.push(request);
      yield { type: 'text-delta', text: ' A grey' };
      yield { type: 'text-delta', text: ' cat. ' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const signal = new AbortController().signal;
  const reader = routeDescriber(llm, { provider: 'vision-a', model: 'eye' });
  expect(await reader.describe(photo, 'What animal is this?', signal)).toBe('A grey cat.');
  expect(requests).toEqual([
    expect.objectContaining({
      provider: 'vision-a',
      model: 'eye',
      signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', attachment: photo },
            { type: 'text', text: 'The user asked: What animal is this?\nDescribe this image.' },
          ],
        },
      ],
    }),
  ]);
});

it('rejects partial descriptions when the shared Llm stream finishes with a failure', async () => {
  const llm: Llm = {
    async *stream() {
      yield { type: 'text-delta', text: 'An unfinished description' };
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'vision quota exceeded' } } };
    },
  };
  const reader = routeDescriber(llm, { provider: 'vision-a', model: 'eye' });
  await expect(reader.describe(photo, '')).rejects.toThrow('vision quota exceeded');
});

it('without any service, tells the model it cannot see the photo and how the owner can fix that', async () => {
  const test = kernel();
  apply(test.ctx, config({ services: [] }));
  await call(test.ctx);
  expect(textOf(test.sent)).toContain('no photo reading service is turned on');
  expect(textOf(test.sent)).toContain('under Models');
});

it('leaves other routes, text-only chats and offloaded photos alone', async () => {
  const test = kernel();
  apply(test.ctx, config());
  const offloaded = { role: 'user', content: [{ type: 'image', attachment: photo, offloaded: true }] };
  await call(test.ctx, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, offloaded]);
  expect(test.asked).toEqual([]);
  expect(textOf(test.sent)).toContain('"offloaded":true');
});

it('uses the free service only after the owner agreed', async () => {
  const requests: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: 'A dog.' } }] });
  }) as typeof fetch;
  const free = freeDescriber(
    { readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }) },
    { baseUrl: 'http://free/v1', models: ['m1'] },
    fetchImpl,
  );
  expect(await free.describe(photo, 'What is it?')).toBe('A dog.');
  expect(JSON.stringify(requests[0])).toContain('data:image/jpeg;base64,AQID');

  const declined = kernel();
  apply(declined.ctx, config({ services: [], home: home('off') }));
  await call(declined.ctx);
  expect(textOf(declined.sent)).toContain('no photo reading service is turned on');
});
