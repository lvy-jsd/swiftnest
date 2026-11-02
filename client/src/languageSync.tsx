import { useEffect, useRef, useState } from 'react';
import { useConnection } from './connection';
import { LOCALE_KEY, PENDING_LOCALE_KEY, useI18n } from './i18n';
import type { Locale } from './i18n';
import { isTauriRuntime } from './runtime';

/** Server is authoritative after pairing; offline choices are retried until acknowledged. */
export function LanguageSync() {
  const { store, status } = useConnection();
  const { locale, acceptServerLocale, t } = useI18n();
  const [failed, setFailed] = useState(false);
  const pending = useRef<Locale | undefined>(undefined);
  useEffect(() => {
    if (isTauriRuntime()) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_language', { lang: locale })).catch(() => setFailed(true));
  }, [locale]);
  useEffect(() => {
    const client = status === 'connected' ? store.client : undefined;
    let ended = false, running = false, changed = 0;
    try { const value = localStorage.getItem(PENDING_LOCALE_KEY); if (value === 'en' || value === 'zh-CN') pending.current = value; } catch { /* Storage unavailable. */ }
    async function sync() {
      if (!client || running || ended) return;
      running = true;
      const generation = changed, choice = pending.current;
      try {
        const result = choice ? await client.setLanguage(choice) : await client.getLanguage();
        if (ended || changed !== generation) return;
        if (result.lang !== 'en' && result.lang !== 'zh-CN') throw new Error('Invalid language response');
        pending.current = undefined;
        try { localStorage.removeItem(PENDING_LOCALE_KEY); } catch { /* Storage unavailable. */ }
        acceptServerLocale(result.lang); setFailed(false);
      } catch { if (!ended) setFailed(true); }
      finally { running = false; if (!ended && changed !== generation) void sync(); }
    }
    const choose = (event: Event) => { changed++; const choice = (event as CustomEvent<Locale>).detail; if (choice === 'en' || choice === 'zh-CN') pending.current = choice; try { const value = localStorage.getItem(LOCALE_KEY); if (value === 'en' || value === 'zh-CN') pending.current = value; } catch { /* Storage unavailable. */ } void sync(); };
    window.addEventListener('swiftnest-language', choose);
    const timer = setInterval(() => void sync(), 2000);
    void sync();
    return () => { ended = true; clearInterval(timer); window.removeEventListener('swiftnest-language', choose); };
  }, [store, status, acceptServerLocale]);
  return failed ? <p role="status">{t('languageSyncFailed')}</p> : null;
}
