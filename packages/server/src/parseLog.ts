import type { LoggerEvent } from "./checkReactCompiler";

type EventLocation = NonNullable<LoggerEvent["fnLoc"]>;

export interface ParsedLog {
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  reason: string;
  description: string;
}

function sanitizeReason(reason: string | undefined): string | undefined {
  if (!reason || reason.includes("[object Object]")) {
    return undefined;
  }
  return reason;
}

function resolveErrorLoc(log: LoggerEvent): EventLocation {
  const candidates: Array<EventLocation | undefined> = [
    log.detail?.options?.details?.at(0)?.loc,
    log.detail?.options?.loc,
    log.detail?.loc,
    log.loc,
  ];

  for (const candidate of candidates) {
    if (typeof candidate?.start?.line === "number") {
      return candidate;
    }
  }

  return log.fnLoc;
}

function toZeroBasedLine(line: number): number {
  return Math.max(0, line - 1);
}

function parseReasonAndDescription(log: LoggerEvent): { reason: string; description: string } {
  if (log.kind === "PipelineError" && log.data) {
    const lines = log.data.split(/\r?\n/);
    const firstLine = sanitizeReason(lines[0]?.trim());
    return {
      reason: firstLine ?? "Pipeline error",
      description: lines.length > 1 ? log.data : "",
    };
  }

  const options = log.detail?.options;
  const detailMessage = sanitizeReason(options?.details?.at(0)?.message);
  const reason =
    sanitizeReason(options?.reason) ?? sanitizeReason(log.reason) ?? detailMessage ?? "Unknown reason";
  const description =
    options?.description || (detailMessage && detailMessage !== reason ? detailMessage : "") || "";

  return { reason, description };
}

export function parseLog(log: LoggerEvent): ParsedLog {
  const loc = resolveErrorLoc(log);
  const startLine = loc.start?.line ?? 1;
  const endLine = loc.end?.line ?? loc.start?.line ?? startLine;
  const startChar = loc.start?.column ?? 0;
  const endChar = loc.end?.column ?? loc.start?.column ?? startChar;

  const { reason, description } = parseReasonAndDescription(log);

  return {
    startLine: toZeroBasedLine(startLine),
    endLine: toZeroBasedLine(endLine),
    startChar: Math.max(0, startChar),
    endChar: Math.max(0, endChar),
    reason,
    description,
  };
}
