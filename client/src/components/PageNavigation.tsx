import { createContext, useContext } from 'react';
import type { ShellNavigation } from '../shellNavigation';

/**
 * The shell's navigation state, shared with every slot panel.
 *
 * `null` outside the shell; pages that may render alone use `usePageNavigation`
 * and handle the missing value, while the shell's own panels use `useShell`.
 */
const Context = createContext<ShellNavigation | null>(null);
export const PageNavigationProvider = Context.Provider;
export const usePageNavigation = () => useContext(Context);
export function useShell(): ShellNavigation {
  const navigation = useContext(Context);
  if (!navigation) throw new Error('useShell requires PageNavigationProvider');
  return navigation;
}
