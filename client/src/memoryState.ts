import type { MemoryView } from '@swiftnest/api';

export interface MemoryState {
  view: MemoryView;
  busy: boolean;
  error?: unknown;
}
export type MemoryAction =
  | { type: 'start' }
  | { type: 'loaded'; view: MemoryView }
  | { type: 'failed'; error: unknown };
export const initialMemoryState: MemoryState = { view: { entries: [], topics: [] }, busy: false };

export function memoryReducer(state: MemoryState, action: MemoryAction): MemoryState {
  switch (action.type) {
    case 'start':
      return { ...state, busy: true, error: undefined };
    case 'loaded':
      return { view: action.view, busy: false };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}
