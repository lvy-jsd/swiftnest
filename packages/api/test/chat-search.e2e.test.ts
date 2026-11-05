import { expect, it } from 'vitest';
import { ChatSearchHarness, OLD_CHAT_TEXT } from '../../../client/test/fixtures/chatSearchHarness.js';

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'real kernel indexes old chats and the assistant finds them by Chinese, English and meaning',
  async () => {
    const harness = new ChatSearchHarness();
    try {
      await harness.start();
      const client = harness.client;
      const old = await client.createSession();
      const first = await harness.turn(old.sessionId, OLD_CHAT_TEXT);
      expect(first.filter((event) => event.type === 'error')).toEqual([]);
      for (const query of ['杭州旅行', '杭州', 'bicycle', 'Travel notes']) {
        await expect
          .poll(async () => (await client.searchChats(query)).some((row) => row.sessionId === old.sessionId))
          .toBe(true);
      }
      await expect.poll(async () => (await client.chatSearchStatus()).semantic).toBe(true);
      await expect.poll(() => harness.embeddings.some((batch) => batch.input.includes(OLD_CHAT_TEXT))).toBe(true);
      expect((await client.searchChats('healthy commuting'))[0]).toMatchObject({
        sessionId: old.sessionId,
        snippet: OLD_CHAT_TEXT,
      });
      const fresh = await client.createSession();
      for (const query of ['杭州旅行', 'bicycle', 'healthy commuting']) {
        const events = await harness.turn(fresh.sessionId, `lookup:${query}`);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-result',
              isError: false,
              text: expect.stringContaining(old.sessionId),
            }),
          ]),
        );
      }
      const before = (await client.chatSearchStatus()).indexedMessages;
      await client.rebuildChatSearch();
      expect((await client.chatSearchStatus()).indexedMessages).toBe(before);
      await expect.poll(async () => (await client.chatSearchStatus()).semantic).toBe(true);
      await expect.poll(() => harness.embeddings.filter((batch) => batch.input.includes(OLD_CHAT_TEXT)).length).toBe(2);
      await harness.kernel!.restart();
      await harness.reconnect();
      expect((await harness.client.searchChats('杭州旅行')).some((row) => row.sessionId === old.sessionId)).toBe(true);
      expect((await harness.client.chatSearchStatus()).indexedMessages).toBe(before);
      await expect.poll(async () => (await harness.client.chatSearchStatus()).semantic).toBe(true);
      expect(harness.embeddings.filter((batch) => batch.input.includes(OLD_CHAT_TEXT))).toHaveLength(2);
      const settings = (await harness.client.chatSearchStatus()).settings;
      await harness.client.configureChatSearch({ ...settings, enabled: false });
      const disabled = await harness.turn(fresh.sessionId, 'lookup:bicycle');
      expect(disabled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-result',
            isError: true,
            text: expect.stringContaining('chatSearchDisabled'),
          }),
        ]),
      );
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-70).join('\n')}`, { cause: error });
    } finally {
      await harness.close();
    }
  },
  120_000,
);
