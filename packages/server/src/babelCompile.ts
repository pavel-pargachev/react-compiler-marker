import { PluginObj, transformFromAstSync } from "@babel/core";
import * as BabelParser from "@babel/parser";
import type { ReactCompilerPluginOptions } from "./reactCompilerConfig";

export function getLanguageFromFilename(filename: string): "flow" | "typescript" {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ["js", "jsx", "mjs"].includes(ext ?? "") ? "flow" : "typescript";
}

export function getParseLanguage(languageId: string, filename?: string): "flow" | "typescript" {
  if (languageId === "javascript" || languageId === "javascriptreact") {
    return "flow";
  }
  if (languageId === "typescript" || languageId === "typescriptreact") {
    return "typescript";
  }
  if (filename) {
    return getLanguageFromFilename(filename);
  }
  return "typescript";
}

export function parseSourceFile(
  sourceCode: string,
  filename: string,
  language: "flow" | "typescript"
): ReturnType<typeof BabelParser.parse> {
  return BabelParser.parse(sourceCode, {
    sourceFilename: filename,
    plugins: [language, "jsx"],
    sourceType: "module",
  });
}

export function transformWithReactCompiler(
  plugin: PluginObj,
  sourceCode: string,
  filename: string,
  language: "flow" | "typescript",
  compilerOptions: Record<string, unknown>
): ReturnType<typeof transformFromAstSync> {
  const ast = parseSourceFile(sourceCode, filename, language);

  return transformFromAstSync(ast, sourceCode, {
    filename,
    highlightCode: false,
    retainLines: true,
    plugins: [[plugin, compilerOptions]],
    sourceType: "module",
    configFile: false,
    babelrc: false,
  });
}

export function buildCompilerOptions<TRawEvent>(
  fileOptions: ReactCompilerPluginOptions,
  logger: { logEvent: (filename: string | null, rawEvent: TRawEvent) => void },
  noEmit: boolean,
  defaultOptions: Record<string, unknown>
): Record<string, unknown> {
  const { logger: _fileLogger, ...restFileOptions } = fileOptions;
  return {
    ...defaultOptions,
    ...restFileOptions,
    logger,
    noEmit,
  };
}
