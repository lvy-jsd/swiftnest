# Contributing Guide

Thanks for contributing to Swiftnest! This guide will get you up and running in about ten minutes.

## Development Environment

- Node.js 24 or later
- pnpm (just run `corepack enable`)

```bash
pnpm install
pnpm build        # build all packages
pnpm test         # run all tests (tests source directly, no build step needed)
```

## Repository Structure

| Directory | Contents |
|---|---|
| `packages/protocol` | Shared data schemas for all components (zod) |
| `packages/core` | Core: plugin host, identity, capability registry, permission proxy, audit, task state machine, server and device |
| `packages/sdk` | Developer package for writing plugins, with mock server and mock device |
| `packages/cli` | `swiftnest` CLI |
| `packages/create-swiftnest-plugin` | `npm create swiftnest-plugin` |
| `plugins/*` | Official plugins, with the same status as community plugins |
| `templates/*` | Plugin templates |
| `docs/zh`, `docs/en` | Documentation (Chinese and English) |

## Writing Plugins

The simplest way to contribute is to write a plugin, which usually means wrapping an existing MCP service or a few lines of code into a capability. See [Writing Your First Plugin](docs/en/guide/write-a-plugin.md).

## Submitting Changes

1. Open an issue first to describe what you want to do (small changes can go straight to a PR).
2. Code must have tests; `pnpm build && pnpm test` must pass.
3. User-facing text (CLI output, error messages, documentation) must be **bilingual (English and Chinese)**:
   - CLI and error messages: provide both `en` and `zh` in the corresponding i18n dictionary;
   - Documentation: update both `docs/zh` and `docs/en`. It's fine if you only speak one language — mention it in the PR and maintainers will fill in the other (we use a local model for initial translation + human review).
4. Error messages should clearly state "what went wrong, why, and how to fix it" (the `suggestion` field on `SwiftnestFailure`).
5. Security-related changes (permissions, approvals, pairing, keys) should have their impact called out separately in the PR.

## Security Issues

Please don't report vulnerabilities in public issues. Contact maintainers privately first.

## License

By submitting, you agree that your contribution is licensed under [Apache-2.0](LICENSE).
