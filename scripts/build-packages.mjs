/**
 * Builds the two npm packages from the repo sources:
 *
 *   sdk/ -> sluice-x402  dist/index.js (the SDK, shared/ code bundled in) + dist/types (declarations)
 *   mcp/ -> sluice-mcp   dist/server.js (an executable MCP server, with the SDK bundled in)
 *
 * npm packages are always installed dependencies, never bundled; each package lists its own.
 * Each package's prepack runs this, so `npm pack` and `npm publish` always ship a fresh build.
 *
 *   node scripts/build-packages.mjs [sdk|mcp]     (no argument builds both)
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const common = { bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" };

/** Every file under dir, recursively. */
const filesIn = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));

async function buildSdk() {
  const dir = join(root, "sdk");
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  await build({ ...common, entryPoints: [join(dir, "index.ts")], outfile: join(dir, "dist", "index.js") });

  const types = join(dir, "dist", "types");
  // prettier-ignore
  execFileSync(process.execPath, [
    tsc, join(dir, "index.ts"), "--ignoreConfig", "--declaration", "--emitDeclarationOnly",
    "--outDir", types, "--rootDir", root, "--target", "ES2022", "--module", "ESNext",
    "--moduleResolution", "Bundler", "--allowImportingTsExtensions", "--strict", "--skipLibCheck", "--types", "node",
  ], { stdio: "inherit" });
  // The sources import each other with .ts suffixes; published declarations use the .js form,
  // which every TypeScript setup resolves to the matching .d.ts file.
  for (const file of filesIn(types)) {
    if (!file.endsWith(".d.ts")) continue;
    const text = readFileSync(file, "utf8");
    const fixed = text.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
    if (fixed !== text) writeFileSync(file, fixed);
  }
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  console.log("built sluice-x402 -> sdk/dist");
}

async function buildMcp() {
  const dir = join(root, "mcp");
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: [join(dir, "server.ts")],
    outfile: join(dir, "dist", "server.js"),
    banner: { js: "#!/usr/bin/env node" },
  });
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  console.log("built sluice-mcp -> mcp/dist");
}

const which = process.argv[2];
if (which && which !== "sdk" && which !== "mcp") {
  console.error(`unknown package "${which}"; use sdk, mcp, or nothing for both`);
  process.exit(1);
}
if (!which || which === "sdk") await buildSdk();
if (!which || which === "mcp") await buildMcp();
