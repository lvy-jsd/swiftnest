import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { BUNDLES, PROVIDER_ID, presetPersonaPatch, profileDir, writeProfile } from "../src/profile.js";
import { parseReadyLine, resolveAppDist } from "../src/kernel.js";
import { pairingUrl, webAppUrl } from "../src/pairing.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "swiftnest-profile-"));
  const bundleDir = join(home, "fake-bundle");
  mkdirSync(bundleDir);
  const config = loadConfig(undefined, { SWIFTNEST_HOME: home, SWIFTNEST_MODEL_ID: "m1" });
  return { config, bundleDir };
}

// The pinned web presets use only !!js, always as an unevaluated scalar.
const customTags = [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }];

describe("presetPersonaPatch", () => {
  it.each(["standard", "cordis", "ptc", "minimal"])("changes only the prefix bytes in the real %s preset", name => {
    // Exact fixture copies of @deepseek-ai/dsh-web-app@0.2.1-rc.5/presets (MIT).
    const source = readFileSync(new URL(`./fixtures/dsh-presets/${name}.patch.yml`, import.meta.url), "utf8");
    const persona = 'You are Swiftnest: "hello".\nModel: {{model}} — 欢迎!';
    const patch = presetPersonaPatch(source, persona);
    const originalRow = source.slice(source.indexOf("    - id:")).replace(/^ {4}/gm, "");
    expect(patch).toBe(originalRow.replace(/prefix: (?:>-\n +)?[^\n]+\n/, () => `prefix: ${JSON.stringify(persona)}\n`));
    const original = parse(source, { customTags })[0].insert[0];
    const overridden = parse(patch, { customTags })[0];
    original.config.plugins.find((plugin: { id: string }) => plugin.id === "persona").config.prefix = persona;
    expect(overridden).toEqual(original);
    expect(patch.match(/!!js[^\n]*/g)).toEqual(source.match(/!!js[^\n]*/g));
  });

  it("leaves unknown shapes and presets without a usable persona alone", () => {
    const source = `
- insert:
    - id: preset-unknown
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        plugins:
          - null
          - 42
          - id: other
          - { id: persona, name: unknown, config: { prefix: original } }
          - { id: persona, name: '@deepseek-ai/dsh-persona', config: unknown }
          - { id: persona, name: '@deepseek-ai/dsh-persona', config: { prefix: 42 } }
    - id: preset-no-plugins
      name: '@deepseek-ai/dsh-agent-preset'
      config: { plugins: unknown }
    - id: preset-unknown-config
      name: '@deepseek-ai/dsh-agent-preset'
      config: unknown
    - id: unrelated
      config: { plugins: [{ id: persona, config: { prefix: original } }] }
- insert: unknown
- null
`;
    expect(presetPersonaPatch(source, "Swiftnest")).toBe("");
    expect(presetPersonaPatch("unknown: shape\n", "Swiftnest")).toBe("");
    expect(() => presetPersonaPatch("[invalid", "Swiftnest")).toThrow(/Invalid DSH preset patch/);
  });

  it("supports direct rows, multiple personas and block prefixes without evaluating !!js", () => {
    const source = `- id: preset-direct
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    extra: !!js throw new Error('must never execute')
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: |-
            Original multiline
            persona
          complete: true
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config: { prefix: original, includeRuntimeContext: false }
`;
    const patch = presetPersonaPatch(source, "Swiftnest");
    const row = parse(patch, { customTags })[0];
    expect(row.config.extra).toBe("throw new Error('must never execute')");
    expect(row.config.plugins.map((plugin: { config: unknown }) => plugin.config)).toEqual([
      { prefix: "Swiftnest", complete: true }, { prefix: "Swiftnest", includeRuntimeContext: false },
    ]);
    expect(patch).toContain("extra: !!js throw new Error('must never execute')");
  });
});

describe("writeProfile", () => {
  it("stacks DSH base, DSH web, then Swiftnest", () => {
    const { config, bundleDir } = setup();
    const dir = writeProfile(config, { bundleDir });
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dsh.profile.bundles).toEqual([...BUNDLES]);
    expect(readlinkSync(join(dir, "node_modules", "@swiftnest", "server-bundle"))).toBe(bundleDir);
  });

  it("writes the model as an OpenAI-compatible provider and the default model", () => {
    const { config, bundleDir } = setup();
    writeProfile(config, { bundleDir });
    const rows = parse(readFileSync(join(profileDir(config), "cordis.patch.yml"), "utf8"), { customTags });
    const llm = rows.find((r: { id: string }) => r.id === "llm-pi-ai");
    expect(llm.config.providers[PROVIDER_ID]).toMatchObject({
      api: "openai-completions",
      apiKeyEnv: config.model.apiKeyEnv,
      baseURL: config.model.baseUrl,
      models: [{ id: "m1" }],
    });
    expect(rows.find((r: { id: string }) => r.id === "agent-default-model").config).toEqual({ provider: PROVIDER_ID, model: "m1" });
  });

  it("keeps the generated system prompt and all installed preset personas in sync", () => {
    const { config, bundleDir } = setup();
    config.persona = "You are the configured Swiftnest assistant, powered by {{model}}.";
    const dir = writeProfile(config, { bundleDir });
    const rows = parse(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), { customTags });
    expect(rows.filter((row: { id: string }) => row.id === "system-prompt")).toEqual([
      { id: "system-prompt", config: { personaPrefix: config.persona } },
    ]);
    const presets = rows.filter((row: { name: string }) => row.name === "@deepseek-ai/dsh-agent-preset");
    expect(presets.map((row: { id: string }) => row.id).sort()).toEqual(["preset-cordis", "preset-minimal", "preset-ptc", "preset-standard"]);
    for (const preset of presets) {
      expect(preset.config.plugins.find((plugin: { id: string }) => plugin.id === "persona").config.prefix).toBe(config.persona);
    }
    writeProfile(config, { bundleDir });
    expect(parse(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), { customTags })).toEqual(rows);
  });

  it("keeps the operator's user.patch.yml and is idempotent", () => {
    const { config, bundleDir } = setup();
    writeProfile(config, { bundleDir });
    const user = join(profileDir(config), "user.patch.yml");
    writeFileSync(user, "- id: mine\n");
    writeProfile(config, { bundleDir });
    expect(readFileSync(user, "utf8")).toBe("- id: mine\n");
  });
});

describe("kernel output and pairing", () => {
  it("parses the ready line and strips the token from the URL", () => {
    expect(parseReadyLine("dsh web: http://127.0.0.1:3077/?token=abc")).toEqual({ url: "http://127.0.0.1:3077/", token: "abc" });
    expect(parseReadyLine("something else")).toBeUndefined();
    expect(parseReadyLine('dsh web: listening on 192.168.1.5 over plain HTTP')).toBeUndefined();
  });

  it("builds the App pairing URL", () => {
    expect(pairingUrl("http://192.168.1.5:3077/", "t0k")).toBe("http://192.168.1.5:3077/connect?token=t0k&interactions=answer");
  });

  it('embeds the entire pairing URL in the web App hash', () => {
    const root = 'http://192.168.1.5:3077/'; const token = 'a+b&c';
    const url = new URL(webAppUrl(root, token));
    expect(url.pathname).toBe('/app/');
    expect(new URLSearchParams(url.hash.split('?')[1]).get('url')).toBe(pairingUrl(root, token));
  });

  it('resolves installed App dist and tolerates a server-only installation', () => {
    expect(resolveAppDist(id => { expect(id).toBe('@swiftnest/app/package.json'); return '/installed/app/package.json'; })).toBe('/installed/app/dist');
    expect(resolveAppDist(() => { throw new Error('not installed'); })).toBeUndefined();
  });
});
