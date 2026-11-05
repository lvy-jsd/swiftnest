import { afterEach, expect, it, vi } from 'vitest';
import { chatFromHash, subscribeToRoute } from '../src/shellNavigation';
import { ComposerState } from '../src/composerState';

afterEach(() => vi.unstubAllGlobals());

it('switches the draft owner on synchronous fragment navigation before the queued hashchange', () => {
  const browser = Object.assign(new EventTarget(), { location: { hash: '#/' } });
  vi.stubGlobal('window', browser);
  const drafts = new ComposerState();
  let renderedHash = browser.location.hash;
  const changed = vi.fn(() => {
    renderedHash = browser.location.hash;
  });
  const stop = subscribeToRoute(changed);
  try {
    // Fragment navigation fires popstate during navigation, then queues hashchange.
    browser.location.hash = '#/chats/after-restart';
    browser.dispatchEvent(new Event('popstate'));
    drafts.update(chatFromHash(renderedHash) ?? 'home', { text: 'hi after restart' });
    browser.dispatchEvent(new Event('hashchange'));
    expect(drafts.get('after-restart').text).toBe('hi after restart');
    expect(drafts.get('home').text).toBe('');
    expect(renderedHash).toBe('#/chats/after-restart');
  } finally {
    stop();
  }
  changed.mockClear();
  browser.dispatchEvent(new Event('popstate'));
  browser.dispatchEvent(new Event('hashchange'));
  expect(changed).not.toHaveBeenCalled();
});
