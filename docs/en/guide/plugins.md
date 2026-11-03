# Plugins

The third-party DSH plugins Swiftnest Server can load have one source: [`server/plugins.json`](https://github.com/lvy-jsd/swiftnest/blob/main/server/plugins.json). The approach follows the community [DeepSeek Harness Ultimate](https://github.com/18126295767-cell/deepseek-harness-ultimate) profile:

- every plugin is pinned to an exact version and npm integrity hash (Tool Ultra to a full commit), checked after installation;
- only MIT, Apache-2.0 and BSD-3-Clause licenses are accepted; the manifest test rejects others;
- one plugin per job;
- plugins that send data out or need accounts are off by default;
- dependency install scripts do not run.

## Plugin list

| id              | Plugin                                                                         | Default | What it does                                          |
| --------------- | ------------------------------------------------------------------------------ | ------- | ----------------------------------------------------- |
| `tool-ultra`    | [Tool Ultra](./tool-ultra.md)                                                  | on      | On-demand tool loading, risk gate, device tools       |
| `market`        | DSH's own plugin market                                                        | off     | Browse the community catalog under Plugins → Discover |
| `safety-net`    | [cc-safety-net](https://github.com/kenryu42/cc-safety-net)                     | on      | Blocks destructive commands and secret reads          |
| `auto-continue` | [dsh-client-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) | on      | Continues after recoverable interruptions             |
| `smart-title`   | [dsh-smart-title](https://github.com/weibaohui/dsh-smart-title)                | on      | Titles sessions from what they are about              |
| `cost-meter`    | [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)                | on      | Tracks external model cost and tokens, sets budgets   |
| `vision-router` | [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)               | off     | Image understanding for text-only models (cloud)      |
| `im`            | [dsh-im](https://github.com/xmanrui/dsh-im)                                    | off     | WeChat, QQ, Feishu, DingTalk, Telegram and more bots  |

cc-safety-net is a blocklist, an extra layer on top of the default-deny rules.

## Plugin market

`market` turns on DSH's own community plugin market with the [dsh-plugin-catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) index, refreshed daily. It is for advanced users and off by default; everyone else only needs the audited plugins above. While it is on, plugins installed under Plugins → Discover survive restarts, and the startup log marks them as not audited by Swiftnest. Turning the market off removes them.

## Install and toggle

```sh
swiftnest-server plugins install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

Installation builds Tool Ultra, installs the enabled npm plugins into `<home>/dsh/profiles/swiftnest` with DSH's own `dsh plugin install`, then checks their integrity. It needs Git, npm, pnpm, Node 24 and network access. Startup never downloads plugins; a missing one produces a hint and the server starts normally.

Toggle by id. Precedence, lowest first: the manifest default, the config file, the App's switches, `SWIFTNEST_PLUGINS`:

```yaml
plugins:
  im: true
  smart-title: false
```

```sh
SWIFTNEST_PLUGINS=im=true,smart-title=false
```

Rerun `plugins install` and restart after changing them. Before enabling `vision-router`, configure a vision model (for example Gemini) in its settings and turn off its keyless cloud fallback, or images go to its default service.

## From the App

The App's plugin page lists the audited plugins with a name and a one-line description in the owner's language. Opt-in plugins carry a note on what to know first. The owner flips switches, then applies them: Swiftnest Server installs what is missing, checks integrity and restarts DSH. If DSH does not start with the new plugins, the server restores the plugins that last started and reports the failure, so the server stays reachable. Switches are saved in `<home>/plugin-settings.json`. A plugin set by `SWIFTNEST_PLUGINS` shows as locked.

Restarting DSH changes its launch token. Web App sessions survive it; a native App paired through `/connect` has to pair again.

The owner-only API behind the page, also available as `SwiftnestClient.listPlugins`, `setPluginEnabled` and `applyPlugins`:

| Request                                    | Answer                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `GET /swiftnest/api/plugins`               | `PluginsView`                                         |
| `POST /swiftnest/api/plugins/{id}/enable`  | `PluginsView`; 404 for an unknown id, 409 when locked |
| `POST /swiftnest/api/plugins/{id}/disable` | Same as enable                                        |
| `POST /swiftnest/api/plugins/apply`        | 202 `PluginsView`; 409 while an apply is running      |

`PluginsView` has three parts:

- `plugins`: for each plugin, `id`, `title`, `summary`, `note?`, `enabled`, `recommended` (on by default), `active` (loaded by the running DSH), `locked`, `license` and `homepage?`;
- `unaudited`: package names installed from the community market;
- `pending` and `apply`: `pending` is true when a switch differs from what is loaded, and `apply` is `{ state: idle | installing | restarting | failed, rolledBack?, error? }`.

The device event stream sends `plugins-changed` when any of this changes. The apply answer arrives before the restart, so expect the connection to drop briefly and read `apply.state` again afterwards.

## Adding a plugin

1. Check the license is allowed and the job is not already covered;
2. add an entry to `server/plugins.json` with the exact version and the value of `npm view <package>@<version> dist.integrity`;
3. set `"enabled": false` with a `reason` if it needs accounts or sends data out;
4. run `SWIFTNEST_PLUGINS_E2E=1 pnpm vitest run server/test/plugins.e2e.test.ts`, which installs the default plugins for real and boots the kernel. CI runs it too.
