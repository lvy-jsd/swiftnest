# DSH preset fixtures

The four `*.patch.yml` files are unmodified copies of
`@deepseek-ai/dsh-web-app@0.2.1-rc.5/presets`, resolved from the installed
`@deepseek-ai/dsh@0.2.1-rc.5` dependency.

Upstream: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
`packages/bundle/web-app/presets`. These fixtures are covered by the upstream
MIT [license](LICENSE), copied from the installed DSH package.

Keep the YAML bytes intact when refreshing fixtures during a pinned DSH upgrade:
the transformation tests verify that only the persona prefix changes, including
preservation of comments, block scalars and `!!js` expressions.
