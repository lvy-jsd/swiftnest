/** Synthetic published packages for profile tests; no source checkout or build marker. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { TOOL_ULTRA_PACKAGES } from '../../src/tool-ultra.js';

export function toolUltraPackages(profile: string): void {
  for (const pkg of TOOL_ULTRA_PACKAGES) {
    const dir = join(profile, 'node_modules', pkg.package);
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: pkg.package,
        version: pkg.version,
        type: 'module',
        exports: { '.': './lib/index.js', './package.json': './package.json' },
      }),
    );
    writeFileSync(join(dir, 'lib/index.js'), 'export function apply() {}\n');
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      stringify([
        {
          insert: [
            { id: pkg.package, name: pkg.package, config: { uniqueDefault: pkg.package, nested: { enabled: true } } },
          ],
        },
      ]),
    );
  }
  writeFileSync(join(profile, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(profile, 'pnpm-lock.yaml'),
    stringify({
      packages: Object.fromEntries(
        TOOL_ULTRA_PACKAGES.map((pkg) => [
          `${pkg.package}@${pkg.version}`,
          { resolution: { integrity: pkg.integrity } },
        ]),
      ),
    }),
  );
}
