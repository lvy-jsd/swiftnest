/**
 * Services that look at a photo and describe it in text: vision models reached with
 * the owner's own keys (through DSH, which knows each provider's API), and the free
 * anonymous service, which is used only once the owner has agreed to it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What DSH keeps for a stored photo. */
export interface ImageRef {
  attachmentId: string;
  mediaType: string;
  width: number;
  height: number;
  name?: string;
}

export interface VisionRoute {
  provider: string;
  model: string;
}

export interface FreeVision {
  /** OpenAI-compatible base URL, including `/v1`. */
  baseUrl: string;
  /** Tried in order; the first that answers wins. */
  models: string[];
}

interface Chunk {
  type: string;
  text?: string;
  reason?: { kind: string; failure?: { message: string } };
}

/** One model call as DSH takes it; the rest of DSH's request fields pass through untouched. */
export interface LlmRequest {
  provider: string;
  model: string;
  messages: readonly { role: string; content: readonly unknown[] }[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface VisionLlm {
  stream(options: LlmRequest): AsyncIterable<Chunk>;
}

export interface VisionAttachments {
  readImage(ref: ImageRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>;
}

/** One way to turn a photo into text. */
export interface Describer {
  /** Shown to the main model so it knows where the description came from. */
  label: string;
  describe(image: ImageRef, question: string, signal?: AbortSignal): Promise<string>;
}

const DESCRIBE_TOKENS = 1500;

/** Prompt for the seeing model; the main model answers the user from this text alone. */
export const DESCRIBE_SYSTEM =
  'You are the eyes of an assistant that cannot see images. Describe the image so the assistant can ' +
  'answer the user without seeing it: the subject, layout, people and objects, colours, and every piece ' +
  'of visible text transcribed exactly. For screenshots, documents, charts and tables, give their full ' +
  'content. Be factual; say when something is unclear. Reply in the language of the user question.';

export function describePrompt(question: string): string {
  return question.trim() ? `The user asked: ${question.trim()}\nDescribe this image.` : 'Describe this image.';
}

/** A vision model reached through DSH with the owner's key. */
export function routeDescriber(llm: VisionLlm, route: VisionRoute): Describer {
  return {
    label: `${route.provider}/${route.model}`,
    async describe(image, question, signal) {
      const content = [
        { type: 'image', attachment: image },
        { type: 'text', text: describePrompt(question) },
      ];
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        system: DESCRIBE_SYSTEM,
        messages: [{ role: 'user', content }],
        maxTokens: DESCRIBE_TOKENS,
        ...(signal ? { signal } : {}),
      });
      return collectText(chunks);
    },
  };
}

async function collectText(chunks: AsyncIterable<Chunk>): Promise<string> {
  let text = '';
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text ?? '';
    const failure = chunk.type === 'finish' ? chunk.reason?.failure : undefined;
    if (failure) throw new Error(failure.message);
  }
  if (!text.trim()) throw new Error('the vision model returned no description');
  return text.trim();
}

/** The free anonymous service: OpenAI-compatible, no key, no account. */
export function freeDescriber(
  attachments: VisionAttachments,
  free: FreeVision,
  fetchImpl: typeof fetch = fetch,
): Describer {
  return {
    label: 'free vision service',
    async describe(image, question, signal) {
      const { data } = await attachments.readImage(image, signal);
      const url = `data:${image.mediaType};base64,${Buffer.from(data).toString('base64')}`;
      const errors: string[] = [];
      for (const model of free.models) {
        try {
          return await askOpenAiCompatible(fetchImpl, free.baseUrl, model, url, question, signal);
        } catch (error) {
          errors.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(errors.join('; '));
    },
  };
}

async function askOpenAiCompatible(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  imageUrl: string,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: DESCRIBE_TOKENS,
      messages: [
        { role: 'system', content: DESCRIBE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: describePrompt(question) },
          ],
        },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('no description in the answer');
  return text.trim();
}

/**
 * The owner's answer to "send photos to the free service?", saved by the server in
 * `<home>/models.json` as `freeVision`. Read at each use, so agreeing in the App takes
 * effect at once. Anything other than `on` means no.
 */
export function freeVisionAgreed(home: string): boolean {
  try {
    const saved = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8')) as { freeVision?: unknown };
    return saved.freeVision === 'on';
  } catch {
    return false;
  }
}
