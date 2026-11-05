/** Scripted model, real DSH lifecycle, encrypted owner API, and real disk transactions. */
import { expect, it } from 'vitest';
import { MemoryHarness } from '../../../client/test/fixtures/memoryHarness';

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'quiet chats automatically add and replace durable facts with their own main model',
  async () => {
    const harness = new MemoryHarness();
    harness.autoProposal = ({ entries, messages }) => {
      const coffee = messages.some((item) => item.text.includes('coffee'));
      return entries.length
        ? [{ op: 'update', id: entries[0]!.id, text: coffee ? 'Prefers coffee' : 'Prefers tea' }]
        : [{ op: 'add', text: 'Prefers tea' }];
    };
    try {
      await harness.start(100);
      expect(await harness.client.memoryAutoSettings()).toEqual({ enabled: true });
      const first = await harness.client.createSession();
      await harness.turn(first.sessionId, 'I prefer tea every morning.');
      await expect.poll(async () => (await harness.client.recentAutoMemory()).length, { timeout: 15_000 }).toBe(1);
      const original = (await harness.client.recentAutoMemory())[0]!;
      expect(original).toMatchObject({ text: 'Prefers tea', source: 'auto', added: expect.any(String) });
      await expect
        .poll(async () => (await harness.client.searchChats('tea')).some((row) => row.sessionId === first.sessionId))
        .toBe(true);
      const second = await harness.client.createSession();
      await harness.turn(second.sessionId, 'I now prefer coffee instead of tea.');
      await expect
        .poll(async () => (await harness.client.recentAutoMemory())[0]?.text, { timeout: 15_000 })
        .toBe('Prefers coffee');
      expect((await harness.client.recentAutoMemory())[0]!.id).toBe(original.id);
      expect((await harness.client.listMemory()).entries).toHaveLength(1);
      expect(harness.autoReviews).toHaveLength(2);
      expect(harness.autoReviews[1]!.entries).toMatchObject([{ id: original.id, text: 'Prefers tea' }]);
      expect(harness.autoReviews[1]!.messages.filter((item) => item.role === 'user')).toEqual([
        { role: 'user', text: 'I now prefer coffee instead of tea.' },
      ]);
      await harness.client.setMemoryAuto(false);
      await harness.turn(second.sessionId, 'Please remember that I like water.');
      await expect
        .poll(async () => (await harness.client.searchChats('water')).some((row) => row.sessionId === second.sessionId))
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(harness.autoReviews).toHaveLength(2);
      await harness.client.setMemoryAuto(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(harness.autoReviews).toHaveLength(2);
      const before = (await harness.client.recentAutoMemory())[0]!.added;
      await harness.turn(second.sessionId, 'Coffee is still my morning preference.');
      await expect
        .poll(async () => (await harness.client.recentAutoMemory())[0]?.added, { timeout: 15_000 })
        .not.toBe(before);
      expect(harness.autoReviews).toHaveLength(3);
      expect(harness.autoReviews[2]!.messages.filter((item) => item.role === 'user')).toEqual([
        { role: 'user', text: 'Coffee is still my morning preference.' },
      ]);
      await harness.client.deleteMemory(original.id);
      expect(await harness.client.recentAutoMemory()).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-35).join('\n')}`, { cause: error });
    } finally {
      await harness.close();
    }
  },
  90_000,
);

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'a rejected secret does not block valid facts or replay messages in the next review',
  async () => {
    const harness = new MemoryHarness();
    const secret = 'my api key: sk-abc...';
    harness.autoProposal = ({ entries }) =>
      entries.length
        ? [{ op: 'update', id: entries[0]!.id, text: 'Prefers coffee' }]
        : [
            { op: 'add', text: secret },
            { op: 'add', text: 'Prefers tea' },
          ];
    try {
      await harness.start(100);
      const { sessionId } = await harness.client.createSession();
      await harness.turn(sessionId, `I prefer tea. ${secret}`);
      await expect
        .poll(async () => (await harness.client.recentAutoMemory()).map((entry) => entry.text), { timeout: 15_000 })
        .toEqual(['Prefers tea']);
      await harness.turn(sessionId, 'I now prefer coffee.');
      await expect
        .poll(async () => (await harness.client.recentAutoMemory()).map((entry) => entry.text), { timeout: 15_000 })
        .toEqual(['Prefers coffee']);
      expect(harness.autoReviews).toHaveLength(2);
      expect(harness.autoReviews[1]!.messages.filter((item) => item.role === 'user')).toEqual([
        { role: 'user', text: 'I now prefer coffee.' },
      ]);
      expect(harness.logs.some((line) => line.includes(secret))).toBe(false);
    } finally {
      await harness.close();
    }
  },
  60_000,
);
