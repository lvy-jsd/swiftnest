/** The App's model page: the local model, cloud models the owner added, and which one does what. */
import type { ApplyState } from './plugins.js';

/** A cloud model provider the App offers, with what a beginner needs to sign up. */
export interface ModelProviderView {
  id: string;
  /** Localized display name. */
  name: string;
  /** Where to create an API key. */
  keyUrl: string;
  /** The strong model picked by default; the owner may type another id. */
  recommendedModel: string;
  /** Saved API key, shown only by its last four characters. */
  keyHint?: string;
}

/** A model as `provider` + `model`; `provider: 'local'` is the configured local server. */
export interface ModelRoute {
  provider: string;
  model: string;
}

/** `ask`: every hand-off to the expert waits for the owner's approval. `auto`: the assistant decides. */
export type ExpertApproval = 'ask' | 'auto';

/** May photos go to the free anonymous vision service? `ask`: the owner has not answered yet. */
export type FreeVisionChoice = 'ask' | 'on' | 'off';

export interface ModelsView {
  /** `vision`: the local model reads images itself. */
  local: { name: string; model: string; contextWindow: number; vision: boolean };
  providers: ModelProviderView[];
  /** The model every chat uses. Unset: the local model. */
  main?: ModelRoute;
  /** The stronger model hard tasks go to. Unset: no expert. */
  expert?: ModelRoute;
  expertApproval: ExpertApproval;
  /** Recordings/videos may leave this computer for Google; false until the owner opts in. */
  geminiUploads: boolean;
  /**
   * Photo reading for a main model that cannot see: `readers` are the owner's vision
   * models (by provider id) that describe photos for it, best first; `free` is the
   * owner's answer about the free service. `needed` is false when the main model sees.
   */
  vision: { needed: boolean; readers: string[]; free: FreeVisionChoice };
  /** Saved but not yet running: apply to restart the assistant with them. */
  pending: boolean;
  apply: { state: ApplyState; rolledBack?: boolean; error?: { code: string; message: string; hint: string } };
}

/** Settings the App sends; omitted fields stay as they are, `null` clears a route. */
export interface ModelSettingsUpdate {
  main?: ModelRoute | null;
  expert?: ModelRoute | null;
  expertApproval?: ExpertApproval;
  /** Requires a saved Google key; takes effect through the existing apply flow. */
  geminiUploads?: boolean;
  /** Takes effect at once, without applying. */
  freeVision?: FreeVisionChoice;
}
