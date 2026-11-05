import { createContext, useContext } from 'react';

export type PageNavigation = {
  drawer: boolean;
  openDrawer: () => void;
  newChat: () => void;
  openPreferences: () => void;
};

const Context = createContext<PageNavigation | null>(null);
export const PageNavigationProvider = Context.Provider;
export const usePageNavigation = () => useContext(Context);
