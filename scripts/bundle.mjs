/**
 * Bundle the published entry points (#265). `tsc` compiles src/ to one file
 * per module under dist/; this replaces dist/index.js (the server and CLI) and
 * dist/wgcRecorder.js (the WGC recorder process) with minified,
 * self-contained bundles. Dependencies stay external: npm installs them.
 *
 * The package ships only these two files from dist/ (see "files" in
 * package.json). The rest of dist/ stays for local tooling such as
 * scripts/build-tool-docs.mjs, which imports dist/server.js.
 *
 * Code finds its assets and package.json through src/utils/packageRoot.ts,
 * not relative paths, because bundling moves every module to dist/'s depth.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src", "index.ts"), join(root, "src", "wgcRecorder.ts")],
  outdir: join(root, "dist"),
  allowOverwrite: true,
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  legalComments: "none",
  logLevel: "warning",
});
