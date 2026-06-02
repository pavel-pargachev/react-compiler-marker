import type { CompilerMarker } from "@react-compiler-marker/shared";
import type { File } from "@babel/types";
import { Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getParseLanguage, parseSourceFile } from "./babelCompile";
import { LoggerEvent } from "./checkReactCompiler";
import {
  findCodeLensLine,
  findFunctionForLog,
  findUseMemoDirectiveRange,
  findUseNoMemoDirectiveRange,
  hasFileLevelUseNoMemo,
  hasFunctionUseNoMemo,
} from "./markerAst";
import { parseLog } from "./parseLog";

const FILE_LEVEL_NO_MEMO_REASON = "Skipped due to file-level 'use no memo' directive.";

function parseDocumentAst(document: TextDocument): File | null {
  try {
    return parseSourceFile(
      document.getText(),
      document.uri,
      getParseLanguage(document.languageId, document.uri)
    ) as File;
  } catch {
    return null;
  }
}

function fnLocKey(log: LoggerEvent): string | null {
  const start = log.fnLoc?.start?.line;
  const end = log.fnLoc?.end?.line;
  if (start === undefined || end === undefined) {
    return null;
  }
  return `${start}:${end}`;
}

function skipReasonFromCompilerLog(log: LoggerEvent): string | undefined {
  const reason = log.reason ?? log.detail?.options?.reason;
  if (!reason || reason.includes("[object Object]")) {
    return undefined;
  }
  return reason;
}

function fieldsFromCompilerDirectiveLoc(log: LoggerEvent): Omit<CompilerMarker, "kind"> | null {
  const loc = log.loc;
  if (!loc?.start?.line) {
    return null;
  }

  return {
    startLine: Math.max(0, loc.start.line - 1),
    startCharacter: loc.start.column ?? 0,
    endLine: Math.max(0, (loc.end?.line ?? loc.start.line) - 1),
    endCharacter: loc.end?.column ?? loc.start.column ?? 0,
  };
}

function rangeToMarkerFields(range: Range): Omit<CompilerMarker, "kind"> {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

function fieldsFromSourceDirective(
  ast: File,
  log: LoggerEvent
): Omit<CompilerMarker, "kind"> | null {
  const fn = findFunctionForLog(ast, log);
  if (!fn) {
    return null;
  }

  const useMemoRange = findUseMemoDirectiveRange(fn);
  return useMemoRange ? rangeToMarkerFields(useMemoRange) : null;
}

function fieldsFromOptOutDirective(ast: File, log: LoggerEvent): Omit<CompilerMarker, "kind"> | null {
  const fn = findFunctionForLog(ast, log);
  if (!fn) {
    return null;
  }

  const noMemoRange = findUseNoMemoDirectiveRange(fn);
  return noMemoRange ? rangeToMarkerFields(noMemoRange) : null;
}

function resolveMarkerFields(
  ast: File,
  document: TextDocument,
  log: LoggerEvent,
  suppressVirtual: boolean
): Omit<CompilerMarker, "kind"> | null {
  if (isFunctionBodyOptedOut(ast, log)) {
    const optOutFields = fieldsFromOptOutDirective(ast, log);
    if (optOutFields) {
      return optOutFields;
    }
  }

  const directiveFields = fieldsFromSourceDirective(ast, log);
  if (directiveFields) {
    return directiveFields;
  }

  if (suppressVirtual) {
    return null;
  }

  const fn = findFunctionForLog(ast, log);
  if (!fn) {
    return null;
  }

  const codeLensLine = findCodeLensLine(fn);
  if (codeLensLine === null || codeLensLine < 0 || codeLensLine >= document.lineCount) {
    return null;
  }

  return {
    startLine: codeLensLine,
    startCharacter: 0,
    endLine: codeLensLine,
    endCharacter: 0,
    virtual: true,
    codeLensLine,
  };
}

function isFunctionBodyOptedOut(ast: File, log: LoggerEvent): boolean {
  const fn = findFunctionForLog(ast, log);
  return fn !== null && hasFunctionUseNoMemo(fn);
}

function shouldMarkSourceAsSkipped(
  ast: File,
  log: LoggerEvent,
  skippedByFnLoc: Map<string, LoggerEvent>
): boolean {
  const key = fnLocKey(log);
  return hasFileLevelUseNoMemo(ast) || (key !== null && skippedByFnLoc.has(key)) || isFunctionBodyOptedOut(ast, log);
}

function skipReasonForSourceDirective(
  ast: File,
  log: LoggerEvent,
  skippedByFnLoc: Map<string, LoggerEvent>
): string {
  if (hasFileLevelUseNoMemo(ast)) {
    return FILE_LEVEL_NO_MEMO_REASON;
  }

  const key = fnLocKey(log);
  const skipLog = key ? skippedByFnLoc.get(key) : undefined;
  const fromCompiler = skipLog ? skipReasonFromCompilerLog(skipLog) : undefined;
  if (fromCompiler) {
    return fromCompiler;
  }

  const fn = findFunctionForLog(ast, log);
  if (fn && hasFunctionUseNoMemo(fn)) {
    return "Skipped due to 'use no memo' directive.";
  }

  return "Skipped by React Compiler.";
}

function pushSkippedDirectiveMarker(
  markers: CompilerMarker[],
  ast: File,
  log: LoggerEvent,
  skippedByFnLoc: Map<string, LoggerEvent>
): void {
  const fields =
    fieldsFromOptOutDirective(ast, log) ??
    fieldsFromSourceDirective(ast, log) ??
    fieldsFromCompilerDirectiveLoc(log);
  if (!fields) {
    return;
  }

  markers.push({
    ...fields,
    kind: "skipped",
    skipReason: skipReasonFromCompilerLog(log) ?? skipReasonForSourceDirective(ast, log, skippedByFnLoc),
  });
}

export function generateMarkers(
  document: TextDocument,
  successfulCompilations: LoggerEvent[],
  failedCompilations: LoggerEvent[],
  skippedCompilations: LoggerEvent[] = []
): CompilerMarker[] {
  const ast = parseDocumentAst(document);
  if (!ast) {
    return [];
  }

  const fileLevelUseNoMemo = hasFileLevelUseNoMemo(ast);
  const suppressVirtual = fileLevelUseNoMemo;
  const skippedByFnLoc = new Map<string, LoggerEvent>();
  for (const log of skippedCompilations) {
    const key = fnLocKey(log);
    if (key) {
      skippedByFnLoc.set(key, log);
    }
  }

  const markers: CompilerMarker[] = [];

  for (const log of skippedCompilations) {
    pushSkippedDirectiveMarker(markers, ast, log, skippedByFnLoc);
  }

  for (const log of successfulCompilations) {
    const fields = resolveMarkerFields(ast, document, log, suppressVirtual);
    if (!fields) {
      continue;
    }

    if (fields.virtual) {
      markers.push({ ...fields, kind: "success" });
      continue;
    }

    if (shouldMarkSourceAsSkipped(ast, log, skippedByFnLoc)) {
      markers.push({
        ...fields,
        kind: "skipped",
        skipReason: skipReasonForSourceDirective(ast, log, skippedByFnLoc),
      });
      continue;
    }

    markers.push({ ...fields, kind: "success" });
  }

  for (const log of failedCompilations) {
    const fields = resolveMarkerFields(ast, document, log, suppressVirtual);
    if (!fields) {
      continue;
    }

    if (!fields.virtual && shouldMarkSourceAsSkipped(ast, log, skippedByFnLoc)) {
      markers.push({
        ...fields,
        kind: "skipped",
        skipReason: skipReasonForSourceDirective(ast, log, skippedByFnLoc),
      });
      continue;
    }

    const parsed = parseLog(log);
    markers.push({
      ...fields,
      kind: "error",
      errorReason: parsed.reason,
      errorDescription: parsed.description,
      errorStartLine: parsed.startLine,
      errorStartCharacter: parsed.startChar,
      errorEndLine: parsed.endLine,
      errorEndCharacter: parsed.endChar,
    });
  }

  return markers;
}
