/**
 * Build script for React Compiler Marker VS Code extension
 *
 * Usage:
 *   node esbuild.js                           - Build (dev mode)
 *   node esbuild.js --production              - Build (production)
 *   node esbuild.js --watch                   - Watch mode
 */
const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const rootDir = __dirname;

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

const sharedOptions = {
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
  console.log("Building VS Code extension...");

  const serverCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: [path.join(rootDir, "packages/server/src/server.ts")],
    outfile: path.join(rootDir, "packages/vscode-client/dist/server.js"),
    external: [],
  });

  const clientCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: [path.join(rootDir, "packages/vscode-client/src/extension.ts")],
    outfile: path.join(rootDir, "packages/vscode-client/dist/extension.js"),
    external: ["vscode"],
  });

  const contexts = [serverCtx, clientCtx];

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
