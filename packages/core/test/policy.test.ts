import { render, text } from '@swiftnest/protocol';
import { expect, it } from 'vitest';
import { RulePolicy } from '../src/policy';

const input = { client: { id: 'c' }, device: 'laptop', capability: 'shell', tool: 'run', args: {} };

it('explains a default decision as catalog text, including the capability reason', () => {
  const decision = new RulePolicy().decide({
    ...input,
    risk: 'exec',
    reason: 'uses shell operators (pipes, redirects, globs or substitutions)',
    reasonText: text('usesShellOperatorsPipesRedirectsGlobs'),
  });
  expect(decision.action).toBe('ask');
  expect(decision.reason).toBe('default for exec (uses shell operators (pipes, redirects, globs or substitutions))');
  expect(render(decision.reasonText!, 'zh-CN')).toBe(
    render(
      text('policyDefault', text('riskReason', text('policyExec'), text('usesShellOperatorsPipesRedirectsGlobs'))),
      'zh-CN',
    ),
  );
  expect(render(decision.reasonText!, 'zh-CN')).not.toMatch(/default for/);
});

it("shows an owner's rule note as written", () => {
  const policy = new RulePolicy([{ tool: 'run', action: 'deny', note: '不许在周末跑命令' }]);
  expect(policy.decide({ ...input, risk: 'exec' })).toEqual({ action: 'deny', reason: '不许在周末跑命令' });
});

it('refuses a call that cannot succeed instead of asking the owner about it', () => {
  // cap-files marks a path outside the shared folders as refused: approving it would only delay the same failure.
  const decision = new RulePolicy([{ tool: 'read', action: 'ask' }]).decide({
    ...input,
    capability: 'files',
    tool: 'read',
    risk: 'sensitive',
    reason: '/etc/passwd is outside the shared folders and will be refused',
    reasonText: text('willRefused', '/etc/passwd', text('outsideTheSharedFolders')),
    refused: true,
  });
  expect(decision.action).toBe('deny');
  expect(decision.reason).toBe('refused without asking: /etc/passwd is outside the shared folders and will be refused');
  expect(render(decision.reasonText!, 'zh-CN')).toBe(
    render(text('policyRefused', text('willRefused', '/etc/passwd', text('outsideTheSharedFolders'))), 'zh-CN'),
  );
  expect(render(decision.reasonText!, 'zh-CN')).not.toMatch(/refused without asking/);
});

it("keeps a third-party capability's prose hint when it has no catalog text", () => {
  const decision = new RulePolicy().decide({
    ...input,
    risk: 'sensitive',
    refused: true,
    hint: 'share the folder first',
  });
  expect(decision).toMatchObject({ action: 'deny', hint: 'share the folder first' });
});
