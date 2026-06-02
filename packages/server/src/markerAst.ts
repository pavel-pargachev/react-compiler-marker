import type { File, Node, SourceLocation } from "@babel/types";
import {
  isArrowFunctionExpression,
  isBlockStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isVariableDeclarator,
  VISITOR_KEYS,
} from "@babel/types";
import { Range } from "vscode-languageserver/node";
import type { LoggerEvent } from "./checkReactCompiler";

type FunctionNode =
  | import("@babel/types").FunctionDeclaration
  | import("@babel/types").FunctionExpression
  | import("@babel/types").ArrowFunctionExpression;

function walk(node: Node, visit: (node: Node, parent?: Node) => void, parent?: Node): void {
  visit(node, parent);
  const keys = VISITOR_KEYS[node.type];
  if (!keys) {
    return;
  }

  for (const key of keys) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && "type" in item) {
          walk(item as Node, visit, node);
        }
      }
    } else if (child && typeof child === "object" && "type" in child) {
      walk(child as Node, visit, node);
    }
  }
}

function isFunctionNode(node: Node): node is FunctionNode {
  return (
    isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunctionExpression(node)
  );
}

function getFunctionName(node: FunctionNode, parent?: Node): string | undefined {
  if (isFunctionDeclaration(node)) {
    return node.id?.name;
  }
  if (parent && isVariableDeclarator(parent) && isIdentifier(parent.id)) {
    return parent.id.name;
  }
  return undefined;
}

function spanLineCount(node: FunctionNode): number {
  const loc = node.loc;
  if (!loc) {
    return -1;
  }
  return loc.end.line - loc.start.line;
}

/** True when the AST node span matches the compiler-reported function location. */
function boundsMatchFnLoc(nodeLoc: SourceLocation, log: LoggerEvent): boolean {
  const fnStart = log.fnLoc?.start?.line;
  const fnEnd = log.fnLoc?.end?.line;
  if (fnStart === undefined || fnEnd === undefined) {
    return false;
  }
  return nodeLoc.start.line === fnStart && nodeLoc.end.line === fnEnd;
}

function pickBestFunctionMatch(
  entries: { node: FunctionNode; name?: string }[],
  log: LoggerEvent
): FunctionNode | null {
  if (entries.length === 0) {
    return null;
  }

  let pool = entries;
  if (log.fnName) {
    const byName = entries.filter((entry) => entry.name === log.fnName);
    if (byName.length > 0) {
      pool = byName;
    }
  }

  // Outermost function that still matches the compiler span (not nested arrows inside).
  return pool.sort((a, b) => spanLineCount(b.node) - spanLineCount(a.node))[0].node;
}

export function findFunctionForLog(ast: File, log: LoggerEvent): FunctionNode | null {
  const namedCandidates: { node: FunctionNode; name?: string }[] = [];

  walk(ast, (node, parent) => {
    if (!isFunctionNode(node) || !node.loc) {
      return;
    }
    if (boundsMatchFnLoc(node.loc, log)) {
      namedCandidates.push({ node, name: getFunctionName(node, parent) });
    }
  });

  return pickBestFunctionMatch(namedCandidates, log);
}

function sourceLocationToRange(loc: SourceLocation): Range {
  return Range.create(
    loc.start.line - 1,
    loc.start.column,
    loc.end.line - 1,
    loc.end.column
  );
}

function isUseMemoDirective(value: string): boolean {
  return value === "use memo";
}

function isUseNoMemoDirective(value: string): boolean {
  return value === "use no memo";
}

export function hasFileLevelUseNoMemo(ast: File): boolean {
  return ast.program.directives.some((directive) => isUseNoMemoDirective(directive.value.value));
}

export function hasFunctionUseNoMemo(fn: FunctionNode): boolean {
  const body = fn.body;
  if (!isBlockStatement(body)) {
    return false;
  }
  return body.directives.some((directive) => isUseNoMemoDirective(directive.value.value));
}

function findBodyDirectiveRange(
  fn: FunctionNode,
  matches: (value: string) => boolean
): Range | null {
  const body = fn.body;
  if (!isBlockStatement(body)) {
    return null;
  }

  for (const directive of body.directives) {
    if (matches(directive.value.value) && directive.loc) {
      return sourceLocationToRange(directive.loc);
    }
  }

  return null;
}

export function findUseMemoDirectiveRange(fn: FunctionNode): Range | null {
  return findBodyDirectiveRange(fn, isUseMemoDirective);
}

export function findUseNoMemoDirectiveRange(fn: FunctionNode): Range | null {
  return findBodyDirectiveRange(fn, isUseNoMemoDirective);
}

function codeLensLineFromBlock(block: import("@babel/types").BlockStatement): number {
  const braceLine0 = (block.loc?.start.line ?? 1) - 1;
  const endLine0 = (block.loc?.end.line ?? braceLine0 + 1) - 1;

  // By default, place on the line immediately after the opening brace.
  let codelensLine0 = braceLine0 + 1;

  // Clamp to the end line (do not exceed block end).
  if (codelensLine0 > endLine0) {
    codelensLine0 = endLine0;
  }

  return codelensLine0;
}

export function findCodeLensLine(fn: FunctionNode): number | null {
  const body = fn.body;
  if (isBlockStatement(body)) {
    return codeLensLineFromBlock(body);
  }

  if (body.loc) {
    return body.loc.start.line - 1;
  }

  return null;
}
