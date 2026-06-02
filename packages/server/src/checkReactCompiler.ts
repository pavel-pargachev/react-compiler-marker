import { PluginObj } from "@babel/core";
import * as path from "path";
import {
  buildCompilerOptions,
  getLanguageFromFilename,
  transformWithReactCompiler,
} from "./babelCompile";
import { throttledError } from "./logThrottle";
import {
  getReactCompilerFileContext,
  type ReactCompilerPluginOptions,
} from "./reactCompilerConfig";
import { LRUCache } from "./cache";

type EventLocation = {
  start?: { line?: number; column?: number; index?: number };
  end?: { line?: number; column?: number; index?: number };
};

type Detail = {
  kind?: string;
  loc?: EventLocation;
  message?: string;
};

type Details = {
  reason?: string;
  description?: string;
  suggestions?: string[];
  loc?: EventLocation;
  details?: Array<Detail>;
};

export type LoggerEvent = {
  filename: string | null;
  kind?: string;
  fnLoc: EventLocation;
  fnName?: string;
  reason?: string;
  loc?: EventLocation;
  /** PipelineError stack or message. */
  data?: string;
  detail?: Details & {
    options: Details;
  };
};

const DEFAULT_COMPILER_OPTIONS = {
  noEmit: false,
  panicThreshold: "none",
  environment: {
    enableTreatRefLikeIdentifiersAsRefs: true,
  },
};

const pluginCache = new Map<string, PluginObj>();

function pluginCacheKey(workspaceFolder: string | undefined, babelPluginPath: string): string {
  const folder = workspaceFolder
    ? path.resolve(workspaceFolder).replace(/\\/g, "/")
    : "";
  return `${folder}\0${babelPluginPath}`;
}

export function clearPluginCache(): void {
  pluginCache.clear();
}

interface CompilationResult {
  successfulCompilations: Array<LoggerEvent>;
  failedCompilations: Array<LoggerEvent>;
  skippedCompilations: Array<LoggerEvent>;
}

const compilationCache = new LRUCache<CompilationResult>(100);

export function clearCompilationCache(): void {
  compilationCache.clear();
}

function createCompilationLogger() {
  const successfulCompilations: Array<LoggerEvent> = [];
  const failedCompilations: Array<LoggerEvent> = [];
  const skippedCompilations: Array<LoggerEvent> = [];

  const logger = {
    logEvent(filename: string | null, rawEvent: LoggerEvent) {
      const event = { ...rawEvent, filename };
      switch (event.kind) {
        case "CompileSuccess":
          successfulCompilations.push(event);
          return;
        case "CompileError":
        case "CompileDiagnostic":
        case "PipelineError":
          failedCompilations.push(event);
          return;
        case "CompileSkip":
          skippedCompilations.push(event);
          return;
      }
    },
  };

  return { logger, successfulCompilations, failedCompilations, skippedCompilations };
}

function runBabelPluginReactCompiler(
  BabelPluginReactCompiler: PluginObj | undefined,
  text: string,
  file: string,
  language: "flow" | "typescript",
  fileOptions: ReactCompilerPluginOptions
) {
  const { logger, successfulCompilations, failedCompilations, skippedCompilations } =
    createCompilationLogger();

  const compilerOptions = buildCompilerOptions(
    fileOptions,
    logger,
    true,
    DEFAULT_COMPILER_OPTIONS
  );

  const result = transformWithReactCompiler(
    BabelPluginReactCompiler!,
    text,
    file,
    language,
    compilerOptions
  );

  // eslint-disable-next-line eqeqeq
  if (result?.code == null) {
    throw new Error(
      `Expected babel-plugin-react-compiler to codegen successfully, got: ${result}`
    );
  }

  return {
    successfulCompilations,
    failedCompilations,
    skippedCompilations,
  };
}

function importBabelPluginReactCompiler(
  workspaceFolder: string | undefined,
  babelPluginPath: string
): PluginObj | undefined {
  const cacheKey = pluginCacheKey(workspaceFolder, babelPluginPath);
  const cached = pluginCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let plugin: PluginObj | undefined;

  if (workspaceFolder) {
    try {
      plugin = require(path.join(workspaceFolder, babelPluginPath));
    } catch (error: any) {
      throttledError(
        `Failed to load babel-plugin-react-compiler from workspace: ${error?.message}`
      );
    }
  }

  if (!plugin) {
    try {
      plugin = require("babel-plugin-react-compiler");
    } catch (error: any) {
      throttledError(`Failed to load babel-plugin-react-compiler: ${error?.message}`);
      return undefined;
    }
  }

  if (!plugin) {
    return undefined;
  }

  pluginCache.set(cacheKey, plugin);
  return plugin;
}

function emptyCompilationResult(): CompilationResult {
  return {
    successfulCompilations: [],
    failedCompilations: [],
    skippedCompilations: [],
  };
}

function getCompilationContext(
  filename: string,
  workspaceFolder: string | undefined,
  configFile?: string
): { fileOptions: ReactCompilerPluginOptions; optionsKey: string } | undefined {
  const context = getReactCompilerFileContext(filename, workspaceFolder, configFile);
  if (!context) {
    return undefined;
  }

  const { pluginOptions } = context;
  return { fileOptions: pluginOptions, optionsKey: JSON.stringify(pluginOptions) };
}

export function checkReactCompiler(
  sourceCode: string,
  filename: string,
  workspaceFolder: string | undefined,
  babelPluginPath: string,
  configFile?: string
): CompilationResult {
  const context = getCompilationContext(filename, workspaceFolder, configFile);
  if (!context) {
    return emptyCompilationResult();
  }

  const { fileOptions, optionsKey } = context;

  const cached = compilationCache.get(sourceCode, filename, optionsKey);
  if (cached) {
    return cached;
  }

  const BabelPluginReactCompiler = importBabelPluginReactCompiler(workspaceFolder, babelPluginPath);

  if (!BabelPluginReactCompiler) {
    return emptyCompilationResult();
  }

  try {
    const language = getLanguageFromFilename(filename);
    const result = runBabelPluginReactCompiler(
      BabelPluginReactCompiler,
      sourceCode,
      filename,
      language,
      fileOptions
    );

    compilationCache.set(sourceCode, filename, optionsKey, result);

    return result;
  } catch (error: any) {
    throttledError(`Failed to compile the file. Please check the file content. ${error?.message}`);
    const failedResult = emptyCompilationResult();
    compilationCache.set(sourceCode, filename, optionsKey, failedResult);
    return failedResult;
  }
}

export async function getCompiledOutput(
  sourceCode: string,
  filename: string,
  workspaceFolder: string | undefined,
  babelPluginPath: string,
  configFile?: string
): Promise<string> {
  const BabelPluginReactCompiler = importBabelPluginReactCompiler(workspaceFolder, babelPluginPath);

  if (!BabelPluginReactCompiler) {
    throw new Error("babel-plugin-react-compiler is not available");
  }

  const context = getCompilationContext(filename, workspaceFolder, configFile);
  if (!context) {
    throw new Error("React Compiler config is not available or file is not analyzable");
  }

  const { fileOptions } = context;

  try {
    const language = getLanguageFromFilename(filename);
    const result = transformWithReactCompiler(
      BabelPluginReactCompiler,
      sourceCode,
      filename,
      language,
      buildCompilerOptions(fileOptions, { logEvent() {} }, false, DEFAULT_COMPILER_OPTIONS)
    );

    // eslint-disable-next-line eqeqeq
    if (result?.code == null) {
      throw new Error("Compilation produced no output");
    }
    return result.code;
  } catch (error: any) {
    throw new Error(`Failed to compile the file. Please check the file content. ${error?.message}`);
  }
}
