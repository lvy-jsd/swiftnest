#!/usr/bin/env node
/**
 * npm create swiftnest-plugin@latest [dir] [--name swiftnest-plugin-foo] [--lang zh|en]
 * Copies the capability template, renames it, and pins @swiftnest/sdk to the current release.
 */
import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SDK_VERSION = "^0.0.1";

/** Template location: shipped inside this package when published, or the monorepo's templates/ during development. */
export async function templateDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "template"), join(here, "..", "..", "..", "templates", "capability")]) {
    try {
      if ((await stat(join(p, "package.json"))).isFile()) return p;
    } catch {
      /* try next */
    }
  }
  throw new Error("capability template not found");
}

export function pluginName(dir: string, explicit?: string): string {
  if (explicit) return explicit;
  const base = basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return base.startsWith("swiftnest-plugin-") ? base : `swiftnest-plugin-${base}`;
}

export async function createPlugin(dir: string, name: string): Promise<string> {
  const target = resolve(dir);
  try {
    if ((await readdir(target)).length) throw new Error(`${target} is not empty`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const src = await templateDir();
  await cp(src, target, { recursive: true, filter: (p) => !/(^|\/)(node_modules|dist)(\/|$)|tsbuildinfo$/.test(p.slice(src.length)) });
  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.name = name;
  delete pkg.private;
  pkg.dependencies["@swiftnest/sdk"] = SDK_VERSION;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  // Standalone tsconfig (the template's extends the monorepo base).
  await writeFile(
    join(target, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2024", module: "nodenext", moduleResolution: "nodenext", strict: true, declaration: true,
          outDir: "dist", rootDir: "src", skipLibCheck: true, types: ["node"],
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );
  const index = join(target, "src", "index.ts");
  await writeFile(index, (await readFile(index, "utf8")).replace(/swiftnest-plugin-hello/g, name));
  await rm(join(target, "tsconfig.tsbuildinfo"), { force: true });
  return target;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: "string" }, lang: { type: "string" } } });
  const zh = (values.lang ?? process.env.LANG ?? "").toLowerCase().startsWith("zh");
  const dir = positionals[0] ?? "swiftnest-plugin-hello";
  const name = pluginName(dir, values.name);
  const target = await createPlugin(dir, name);
  process.stdout.write(
    zh
      ? `\n✓ 已创建插件 ${name}：${target}\n\n下一步：\n  cd ${dir}\n  npm install\n  npm test        # 在模拟的巢和设备里跑插件测试\n\n然后把 src/index.ts 里的 greet 工具换成你自己的。\n`
      : `\n✓ Created plugin ${name} in ${target}\n\nNext:\n  cd ${dir}\n  npm install\n  npm test        # runs the plugin against a simulated Nest and device\n\nThen replace the greet tool in src/index.ts with your own.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
