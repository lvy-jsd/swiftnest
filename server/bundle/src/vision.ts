/**
 * Eyes for a main model that cannot see images. That model's route declares image
 * input, so photos are accepted and stay in the chat as photos; before each call to it,
 * this module swaps every photo for a description written by a model that can see. The
 * owner's own vision models come first, then the free service if the owner agreed to it.
 * With neither, the photo becomes a note that tells the user how to turn photo reading
 * on. Each photo is described once and remembered, since every step resends the chat.
 */
import {
  type Describer,
  type FreeVision,
  freeDescriber,
  freeVisionAgreed,
  type ImageRef,
  routeDescriber,
  type VisionAttachments,
  type VisionRoute,
} from './vision-services.js';
import type { Llm, LlmRequest } from './llm.js';

export const name = 'swiftnest-vision';
export const inject = ['llm', 'attachments'];

export interface VisionConfig {
  /** The route whose requests get descriptions instead of photos. */
  provider: string;
  /** Vision models reached with the owner's keys, in the order to try them. */
  services: VisionRoute[];
  /** The anonymous free service; used only after the owner agreed in the App. */
  free: FreeVision;
  /** Swiftnest's home, where the owner's answer is saved. */
  home: string;
}

interface Block {
  type: string;
  text?: string;
  attachment?: ImageRef;
  offloaded?: true;
}

interface Message {
  role: string;
  content: readonly Block[];
}

interface StreamOptions extends LlmRequest {
  messages: readonly Message[];
}

export interface VisionContext {
  llm: Llm;
  attachments: VisionAttachments;
  on(
    event: 'llm/stream',
    listener: (options: StreamOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>,
  ): () => void;
  effect(fn: () => () => void, label?: string): void;
}

export function apply(ctx: VisionContext, config: VisionConfig) {
  const keyed = config.services.map((route) => routeDescriber(ctx.llm, route));
  const free = freeDescriber(ctx.attachments, config.free);
  const eyes = new Eyes(() => (freeVisionAgreed(config.home) ? [...keyed, free] : keyed));
  async function* described(options: StreamOptions) {
    const messages = await eyes.rewrite(options.messages, options.signal);
    yield* ctx.llm.stream({ ...options, messages });
  }
  ctx.effect(
    () =>
      ctx.on('llm/stream', (options, next) =>
        options.provider === config.provider && options.messages.some(hasPhoto) ? described(options) : next(),
      ),
    'swiftnest-vision: describe photos',
  );
}

function isPhoto(block: Block): block is Block & { attachment: ImageRef } {
  return block.type === 'image' && block.attachment !== undefined && block.offloaded !== true;
}

function hasPhoto(message: Message): boolean {
  return message.content.some(isPhoto);
}

/** How many descriptions to remember; older ones are described again if they come back. */
const REMEMBERED = 256;

/** Turns photos into text and remembers the descriptions. */
export class Eyes {
  private readonly seen = new Map<string, string>();

  constructor(private readonly describers: () => Describer[]) {}

  rewrite(messages: readonly Message[], signal?: AbortSignal): Promise<Message[]> {
    return Promise.all(messages.map((message) => (hasPhoto(message) ? this.rewriteMessage(message, signal) : message)));
  }

  private async rewriteMessage(message: Message, signal?: AbortSignal): Promise<Message> {
    const question = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    const content = await Promise.all(
      message.content.map(async (block) =>
        isPhoto(block) ? { type: 'text', text: await this.describe(block.attachment, question, signal) } : block,
      ),
    );
    return { ...message, content };
  }

  private async describe(image: ImageRef, question: string, signal?: AbortSignal): Promise<string> {
    const remembered = this.seen.get(image.attachmentId);
    if (remembered) return remembered;
    const describers = this.describers();
    if (!describers.length) return unseen(image, 'no photo reading service is turned on');
    const errors: string[] = [];
    for (const describer of describers) {
      try {
        const text = seenBy(image, describer.label, await describer.describe(image, question, signal));
        this.remember(image.attachmentId, text);
        return text;
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${describer.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return unseen(image, `every photo reading service failed (${errors.join('; ')})`);
  }

  private remember(id: string, text: string): void {
    this.seen.set(id, text);
    if (this.seen.size > REMEMBERED) this.seen.delete(this.seen.keys().next().value!);
  }
}

function photoName(image: ImageRef): string {
  return `Photo${image.name ? ` "${image.name}"` : ''} (${image.width}x${image.height})`;
}

function seenBy(image: ImageRef, label: string, description: string): string {
  return `[${photoName(image)}. You cannot see images, so ${label} looked at it for you:\n${description}\n]`;
}

function unseen(image: ImageRef, reason: string): string {
  return (
    `[${photoName(image)}. You cannot see images and ${reason}. Tell the user you could not see this photo, ` +
    'and that the owner can turn on photo reading in the Swiftnest App under Models.]'
  );
}
