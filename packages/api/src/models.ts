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

export interface ModelsView {
  local: { name: string; model: string; contextWindow: number };
  providers: ModelProviderView[];
  /** The model every chat uses. Unset: the local model. */
  main?: ModelRoute;
  /** The stronger model hard tasks go to. Unset: no expert. */
  expert?: ModelRoute;
  expertApproval: ExpertApproval;
  /** Saved but not yet running: apply to restart the assistant with them. */
  pending: boolean;
  apply: { state: ApplyState; rolledBack?: boolean; error?: { code: string; message: string; hint: string } };
}

/** Settings the App sends; omitted fields stay as they are, `null` clears a route. */
export interface ModelSettingsUpdate {
  main?: ModelRoute | null;
  expert?: ModelRoute | null;
  expertApproval?: ExpertApproval;
}
