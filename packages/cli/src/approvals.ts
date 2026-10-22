/**
 * Approvals in the owner's terminal — never through the agent. One queue for tool calls waiting for approval and for
 * devices waiting for their pairing fingerprint to be confirmed, so prompts never interleave.
 */
import { createInterface, type Interface } from "node:readline/promises";
import type { Nest } from "@swiftnest/core";
import { t, type Lang } from "./i18n.js";

export function terminalApprovals(nest: Nest, lang: Lang): { rl: Interface; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let terminalOpen = true;
  rl.on("close", () => {
    terminalOpen = false;
  });
  let queue = Promise.resolve();
  const ask = async (prompt: string, fallback: string): Promise<boolean | undefined> => {
    if (!terminalOpen) {
      process.stdout.write(prompt + "\n" + fallback + "\n");
      return undefined;
    }
    try {
      return /^y(es)?$/i.test((await rl.question(prompt)).trim());
    } catch {
      process.stdout.write("\n" + fallback + "\n");
      return undefined;
    }
  };

  const offTasks = nest.tasks.onChange((s) => {
    if (s.state !== "pending_approval") return;
    queue = queue.then(async () => {
      if (nest.tasks.get(s.id)?.state !== "pending_approval") return;
      const prompt = t(lang, "approvalPrompt")(s.client.name ?? s.client.id, s.device, `${s.capability}.${s.tool}`, JSON.stringify(s.args), s.risk, s.reason ?? "");
      const yes = await ask(prompt, t(lang, "noTerminalTask")(s.id));
      if (yes === undefined || nest.tasks.get(s.id)?.state !== "pending_approval") return;
      if (yes) {
        await nest.tasks.approve(s.id, "terminal");
        process.stdout.write(t(lang, "approved") + "\n");
      } else {
        await nest.tasks.deny(s.id, "denied in terminal");
        process.stdout.write(t(lang, "denied") + "\n");
      }
    });
  });

  const offPairing = nest.pairing.onCandidate((c) => {
    queue = queue.then(async () => {
      if (!nest.pairing.pending().some((p) => p.id === c.id)) return;
      const yes = await ask(t(lang, "pairConfirmPrompt")(c.device, c.fingerprint), t(lang, "noTerminalPair")(c.id));
      if (yes === undefined) return;
      nest.pairing.confirm(c.id, yes);
      process.stdout.write((yes ? t(lang, "pairOwnerYes") : t(lang, "pairOwnerNo")) + "\n");
    });
  });

  return {
    rl,
    close() {
      offTasks();
      offPairing();
      rl.close();
    },
  };
}
