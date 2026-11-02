import { describe, expect, it, vi } from 'vitest';
import { exit, onBackButtonPress } from '@tauri-apps/api/app';
import { registerAndroidBack } from '../src/androidBack';

vi.mock('@tauri-apps/api/app', () => ({ exit: vi.fn(), onBackButtonPress: vi.fn() }));

describe('Android system back', () => {
  it('lets app navigation consume back before exiting, and unregisters on cleanup', async () => {
    let onBack: (() => void) | undefined;
    const unregister = vi.fn();
    vi.mocked(onBackButtonPress).mockImplementation(async (handler) => {
      onBack = () => handler({ canGoBack: true });
      return { plugin: 'app', event: 'back-button', channelId: 0, unregister };
    });
    const consume = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const cleanup = await registerAndroidBack(consume);
    onBack!(); // Preferences dismisses.
    onBack!(); // Detail/pairing returns to home.
    expect(exit).not.toHaveBeenCalled();
    onBack!(); // Home exits even if WebView history contains older hash routes.
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    cleanup();
    expect(unregister).toHaveBeenCalledOnce();
  });
});
