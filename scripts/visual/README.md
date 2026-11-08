# Visual regression

Screenshot-based UI regression for the web client. A real DSH kernel with a
fake model boots in-process, a chat is created, and the chat list and chat
detail pages are captured at four breakpoints:

| name    | width | height |
| ------- | ----- | ------ |
| mobile  | 390   | 844    |
| tablet  | 768   | 1024   |
| desktop | 1280  | 800    |
| wide    | 1600  | 900    |

Baselines live in `screenshots/web/` (one PNG per page per breakpoint).
Desktop (Electron) and Android (device) get their own configs and baseline
directories — never mix platforms in one directory, the engines differ and
every run would report noise.

## Run

```sh
pnpm --filter @swiftnest/app build:web   # once, or after client changes
cd scripts/visual
pnpm exec playwright test
```

The kernel binds a free port (port 0), so parallel runs do not collide. If
the Playwright browsers are missing, install them once:

```sh
pnpm exec playwright install chromium
```

## Update baselines

After an intentional design change:

```sh
pnpm exec playwright test --update-snapshots
```

## Read a failure

On a diff, Playwright writes three PNGs per failing shot into
`test-results/<test-name>/`:

- `<name>-actual.png` — what the run produced
- `<name>-diff.png` — the changed pixels highlighted
- the baseline — `screenshots/web/<name>.png`

The HTML report (all runs, with attachments) is in `report/index.html`:

```sh
pnpm exec playwright show-report
```

A diff is a real regression unless the changed pixels are in a masked
region's neighborhood (anti-aliasing). Masked regions are painted magenta in
the screenshots: `time` (server timestamps), the connection-status line and
the detail-page subtitle (both carry the server URL with a random port).
