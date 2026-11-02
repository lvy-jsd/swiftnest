[简体中文](README.zh-CN.md)

`chat.json` records `session/follow` items from the real 0.2.1-rc.5 Swiftnest kernel against the fixed SSE
model in `chat.e2e.test.ts`. Machine-specific paths were replaced with `/workspace` and `/dsh-checkout/`.
Non-chat durable records after the opening snapshot are omitted; stream chunk boundaries are preserved.
The recording includes synthetic user-role runtime/time context to test that it stays out of the App.

To deliberately refresh: `SWIFTNEST_E2E=1 SWIFTNEST_RECORD_FIXTURES=1 pnpm vitest run packages/api/test/chat.e2e.test.ts`.
Review and sanitize paths before retaining the result. No token/cookie is recorded.

`tools-and-error.json` is a constructed protocol fixture (not a claimed live tool recording), based on
`dsh-session/lib/types/types.d.ts` and `dsh-llm/lib/types/message.d.ts`, covering shapes absent from the
fixed text-only model run. The compact in-flight snapshot test is also constructed from the published
`AssistantStreamRecord` definition.
