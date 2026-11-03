import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MemoryHarness } from '../../client/test/fixtures/memoryHarness.js';

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'real kernel remembers, freezes session memory, and recalls later saves',
  async () => {
    const harness = new MemoryHarness();
    try {
      await harness.start();
      const { client } = harness;
      const old = await client.createSession();
      expect((await harness.turn(old.sessionId, 'warm-up')).filter((event) => event.type === 'error')).toEqual([]);
      const snapshot = join(harness.home, 'memory', 'snapshots', `${old.sessionId}.md`);
      const frozen = await readFile(snapshot, 'utf8');
      const saving = await client.createSession();
      const saved = await harness.turn(saving.sessionId, 'remember-now');
      expect(saved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool-result', isError: false, text: expect.stringContaining('Saved.') }),
        ]),
      );
      expect((await client.listMemory()).entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: 'Prefers a quiet workspace' })]),
      );
      const fresh = await client.createSession();
      await harness.turn(fresh.sessionId, 'new-session');
      const prompt = harness.requests.find((item) => item.prompt === 'new-session')!.request;
      expect(JSON.stringify(prompt.messages.filter((message) => message.role === 'system'))).toContain(
        'Prefers a quiet workspace',
      );
      expect(prompt.tools?.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(['remember', 'forget', 'recall']),
      );
      await client.addMemory('Late fact: prefers local storage', 'Preferences');
      const recalled = await harness.turn(old.sessionId, 'recall-later');
      expect(recalled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-result',
            isError: false,
            text: expect.stringContaining('Late fact: prefers local storage'),
          }),
        ]),
      );
      const rejected = await harness.turn(old.sessionId, 'reject-secret');
      expect(rejected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-result',
            isError: true,
            text: expect.stringContaining('memorySecret'),
          }),
        ]),
      );
      expect(await readFile(snapshot, 'utf8')).toBe(frozen);
      const oldPrompt = harness.requests.find((item) => item.prompt === 'recall-later')!.request;
      expect(JSON.stringify(oldPrompt.messages.filter((message) => message.role === 'system'))).not.toContain(
        'Late fact:',
      );
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.stack : error}\n${harness.logs.slice(-60).join('\n')}`, {
        cause: error,
      });
    } finally {
      await harness.close();
    }
  },
  120_000,
);
