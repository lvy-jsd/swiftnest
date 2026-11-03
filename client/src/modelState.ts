import type { ModelProviderView, ModelRoute, ModelSettingsUpdate, ModelsView } from '@swiftnest/api';

export const LOCAL = 'local';
/** Same rule the server checks, so the App never offers a save it would refuse. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const KEY = /^[\x21-\x7e]{8,512}$/;

export function providerName(view: ModelsView, provider: string): string {
  if (provider === LOCAL) return view.local.name;
  return view.providers.find((item) => item.id === provider)?.name ?? provider;
}

export function keyedProviders(view: ModelsView): ModelProviderView[] {
  return view.providers.filter((provider) => provider.keyHint);
}

/** The model a provider is offered with: the one already in use there, else its recommendation. */
export function modelFor(view: ModelsView, provider: ModelProviderView): string {
  for (const route of [view.expert, view.main]) if (route?.provider === provider.id) return route.model;
  return provider.recommendedModel;
}

/** What every chat can run on: the local model or a cloud provider that has a key. */
export function mainChoices(view: ModelsView): ModelRoute[] {
  const local = { provider: LOCAL, model: view.local.model };
  return [
    local,
    ...keyedProviders(view).map((provider) => ({ provider: provider.id, model: modelFor(view, provider) })),
  ];
}

export const routeValue = (route: ModelRoute) => `${route.provider}\n${route.model}`;

export function routeFromValue(value: string): ModelRoute | null {
  const [provider = LOCAL, model = ''] = value.split('\n');
  return provider === LOCAL ? null : { provider, model };
}

export type ExpertDraft = { provider?: ModelProviderView; key: string; model: string };

export function canSaveExpert({ provider, key, model }: ExpertDraft): boolean {
  if (!provider || !MODEL_ID.test(model.trim())) return false;
  return key.trim() ? KEY.test(key.trim()) : !!provider.keyHint;
}

/** Removing a key also clears the routes that used it, so the page never shows a model that cannot run. */
export function routesWithout(view: ModelsView, provider: string): ModelSettingsUpdate {
  return {
    ...(view.main?.provider === provider ? { main: null } : {}),
    ...(view.expert?.provider === provider ? { expert: null } : {}),
  };
}
