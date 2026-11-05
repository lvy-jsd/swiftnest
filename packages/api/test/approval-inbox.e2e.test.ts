import { expect, it } from 'vitest';
import { ApprovalHarness } from '../../../client/test/fixtures/approvalHarness.js';
import type { SwiftnestEvent } from '../src/index.js';

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'real kernel merges DSH and device requests, answers across clients and delivers the result to chat',
  async () => {
    const harness = new ApprovalHarness();
    try {
      await harness.start();
      const client = harness.client!;
      const session = await client.createSession();
      const events = await client.follow(session.sessionId, { signal: AbortSignal.timeout(30000) });
      const output: SwiftnestEvent[] = [];
      const done = (async () => {
        for await (const event of events) {
          output.push(event);
          if (event.type === 'turn-end') break;
        }
      })();
      const device = await harness.writeRequest();
      await client.sendMessage(session.sessionId, 'request-approval');
      await expect.poll(async () => (await client.approvalInbox()).items.length).toBe(2);
      const view = await client.approvalInbox();
      expect(view.items.map((item) => item.kind).sort()).toEqual(['device', 'dsh']);
      const dsh = view.items.find((item) => item.kind === 'dsh')!;
      expect(dsh).toMatchObject({ sessionId: session.sessionId, args: { path: '/shared/report.txt' } });
      const live = await client.watchApprovals({ signal: AbortSignal.timeout(5000) });
      expect((await live.next()).value).toEqual({ type: 'approvals-changed' });
      await client.answerInboxApproval(dsh.id, true);
      await done;
      expect(output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool-result', text: 'approved once' }),
          expect.objectContaining({ type: 'interaction-cancelled', requestId: dsh.id }),
        ]),
      );
      await client.answerDeviceApproval(device.id, false);
      expect((await client.approvalInbox()).items).toEqual([]);
      expect(harness.kernel!.devices.nest.tasks.get(device.id)?.state).toBe('denied');
      const audit = (await client.deviceAudit()).filter((entry) => entry.approval);
      expect(audit).toHaveLength(2);
      expect(
        audit.every((entry) => entry.approval?.answeredBy === 'owner' && entry.approval.answeringDevice !== 'server'),
      ).toBe(true);
      await expect(client.answerInboxApproval(dsh.id, true)).rejects.toMatchObject({ httpStatus: 409 });
      live.close();
      events.close();
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-40).join('\n')}`, { cause: error });
    } finally {
      await harness.close();
    }
  },
  90000,
);
