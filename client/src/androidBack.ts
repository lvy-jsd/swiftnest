import { exit, onBackButtonPress } from '@tauri-apps/api/app';

/** Return true when a sheet/route consumed back; only the home screen exits. */
export async function registerAndroidBack(consumeBack: () => boolean): Promise<() => void> {
  const listener = await onBackButtonPress(() => {
    if (!consumeBack()) void exit(0);
  });
  return () => {
    void listener.unregister();
  };
}
