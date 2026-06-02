import { DEFAULT_REACT_COMPILER_CONFIG_FILE } from "@react-compiler-marker/shared";
import { transformSync } from "@babel/core";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { throttledError } from "./logThrottle";

const commonjsPlugin = require("@babel/plugin-transform-modules-commonjs") as {
  default?: unknown;
};
const commonjsPluginImpl = (commonjsPlugin.default ?? commonjsPlugin) as (
  ...args: unknown[]
) => unknown;

const TS_CONFIG_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

export type ReactCompilerPluginOptions = Record<string, unknown>;

const FILE_INCLUDE = /\.[jt]sx?$/;
const FILE_EXCLUDE = /[\\/]node_modules[\\/]/;

const ANNOTATION_OPTIONS: ReactCompilerPluginOptions = {
  target: "18",
  compilationMode: "annotation",
  eslintSuppressionRules: [],
};

const INFER_OPTIONS: ReactCompilerPluginOptions = {
  target: "18",
  eslintSuppressionRules: [],
};

interface LoadedConfig {
  reactCompilerInclude: RegExp | undefined;
  mtimeMs: number;
}

let cachedConfig: LoadedConfig | undefined;
let cachedConfigPath: string | undefined;

export function clearReactCompilerConfigCache(): void {
  cachedConfig = undefined;
  cachedConfigPath = undefined;
}

function pathRelativeToWorkspace(filename: string, workspaceFolder: string): string {
  const normalized = filename.replace(/\\/g, "/");
  const workspace = workspaceFolder.replace(/\\/g, "/");
  if (!normalized.startsWith(workspace)) {
    return normalized;
  }
  return normalized.slice(workspace.length).replace(/^\//, "");
}

/** RegExp aligned with Babel `reactCompilerPaths` override test/exclude. */
export function buildReactCompilerIncludeRegExp(paths: string[]): RegExp | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const source = paths.map((p) => p.replace(/\//g, "[\\\\/]")).join("|");
  return new RegExp(source);
}

function purgeRequireCacheForConfig(userRequire: NodeRequire, absPath: string): void {
  const resolvedAbs = path.resolve(absPath);
  const configName = path.basename(absPath);
  for (const key of Object.keys(userRequire.cache)) {
    const normalizedKey = key.replace(/\\/g, "/");
    if (
      path.resolve(key) === resolvedAbs ||
      normalizedKey.endsWith(`/${configName}`) ||
      normalizedKey.includes("/.config/")
    ) {
      delete userRequire.cache[key];
    }
  }
}

function evaluateTranspiledConfig(
  workspaceFolder: string,
  absPath: string,
  source: string
): Record<string, unknown> {
  const transpiled = transformSync(source, {
    filename: absPath,
    configFile: false,
    babelrc: false,
    presets: [
      [
        "@babel/preset-typescript",
        {
          onlyRemoveTypeImports: true,
        },
      ],
    ],
    plugins: [[commonjsPluginImpl, { lazy: false }]],
  });

  if (!transpiled?.code) {
    throw new Error("Failed to transpile React Compiler config");
  }

  const module = { exports: {} as Record<string, unknown> };
  const userRequire = createRequire(path.join(workspaceFolder, "package.json"));
  const dirname = path.dirname(absPath);
  const run = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    transpiled.code
  ) as (
    exports: Record<string, unknown>,
    require: NodeRequire,
    module: { exports: Record<string, unknown> },
    filename: string,
    dirname: string
  ) => void;
  run(module.exports, userRequire, module, absPath, dirname);
  return module.exports;
}

function loadConfigModule(workspaceFolder: string, absPath: string): unknown {
  const ext = path.extname(absPath).toLowerCase();
  if (TS_CONFIG_EXTENSIONS.has(ext)) {
    const source = fs.readFileSync(absPath, "utf8");
    return evaluateTranspiledConfig(workspaceFolder, absPath, source);
  }

  const userRequire = createRequire(path.join(workspaceFolder, "package.json"));
  purgeRequireCacheForConfig(userRequire, absPath);
  return userRequire(absPath);
}

function loadConfig(workspaceFolder: string, configFile: string): LoadedConfig | undefined {
  const absPath = path.resolve(workspaceFolder, configFile);

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(absPath).mtimeMs;
  } catch {
    throttledError(`React Compiler config not found: ${absPath}`);
    return undefined;
  }

  if (cachedConfig && cachedConfigPath === absPath && cachedConfig.mtimeMs === mtimeMs) {
    return cachedConfig;
  }

  try {
    const exported = loadConfigModule(workspaceFolder, absPath) as {
      default?: unknown;
      reactCompilerPaths?: unknown;
    };
    const mod = (exported.default ?? exported) as { reactCompilerPaths?: unknown };
    const paths = mod.reactCompilerPaths;

    if (!Array.isArray(paths) || !paths.every((item) => typeof item === "string")) {
      throttledError(
        `React Compiler config "${absPath}" must export \`reactCompilerPaths\` as an array of strings`
      );
      return undefined;
    }

    cachedConfig = {
      reactCompilerInclude: buildReactCompilerIncludeRegExp(paths),
      mtimeMs,
    };
    cachedConfigPath = absPath;
    return cachedConfig;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throttledError(`Failed to load React Compiler config "${absPath}": ${message}`);
    return undefined;
  }
}

export function shouldAnalyzeFile(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  return FILE_INCLUDE.test(normalized) && !FILE_EXCLUDE.test(filename);
}

export function isReactCompilerConfigReady(
  workspaceFolder: string | undefined,
  configFile: string = DEFAULT_REACT_COMPILER_CONFIG_FILE
): boolean {
  return workspaceFolder ? loadConfig(workspaceFolder, configFile) !== undefined : false;
}

export function getReactCompilerFileContext(
  filename: string,
  workspaceFolder: string | undefined,
  configFile: string = DEFAULT_REACT_COMPILER_CONFIG_FILE
): { pluginOptions: ReactCompilerPluginOptions; inReactCompilerPaths: boolean } | undefined {
  if (!workspaceFolder || !shouldAnalyzeFile(filename)) {
    return undefined;
  }

  const loaded = loadConfig(workspaceFolder, configFile);
  if (!loaded) {
    return undefined;
  }

  const include = loaded.reactCompilerInclude;
  const relativePath = pathRelativeToWorkspace(filename, workspaceFolder);
  const inReactCompilerPaths = include?.test(relativePath) ?? false;
  const pluginOptions =
    include && inReactCompilerPaths ? INFER_OPTIONS : ANNOTATION_OPTIONS;

  return { pluginOptions, inReactCompilerPaths };
}
