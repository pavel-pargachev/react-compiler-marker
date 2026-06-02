import type { CompilerMarker } from "@react-compiler-marker/shared";

export const VIRTUAL_USE_MEMO_LABEL = "'use memo';";

const fmt = {
  link: (text: string, url: string) => `[${text}](${url})`,
  hr: () => "\n\n---\n\n",
  br2: () => "\n\n",
};

function previewCompiledCommandLink(documentUri: string): string {
  return `command:react-compiler-marker.previewCompiled?${encodeURIComponent(
    JSON.stringify({ uri: documentUri })
  )}`;
}

function buildSuccessHoverMarkdown(documentUri: string): string {
  return (
    "This component will be auto-memoized by React Compiler." +
    fmt.br2() +
    fmt.link("Click to preview compiled output", previewCompiledCommandLink(documentUri))
  );
}

function buildErrorHoverMarkdown(marker: CompilerMarker, documentUri: string): string {
  let hoverMarkdown = "This component will not be auto-memoized by React Compiler.";
  hoverMarkdown += fmt.hr();

  if (marker.errorReason) {
    hoverMarkdown += `Error: ${marker.errorReason}${fmt.br2()}`;
  }

  if (marker.errorDescription) {
    hoverMarkdown += `${marker.errorDescription}${fmt.br2()}`;
  }

  const { errorStartLine: startLine, errorEndLine: endLine, errorStartCharacter: startChar, errorEndCharacter: endChar } =
    marker;

  if (startLine !== undefined || endLine !== undefined) {
    const resolvedStart = startLine ?? endLine ?? 0;
    const resolvedEnd = endLine ?? startLine ?? resolvedStart;
    const lineText =
      resolvedStart === resolvedEnd
        ? `Line ${resolvedStart + 1}`
        : `Lines ${resolvedStart + 1}–${resolvedEnd + 1}`;

    const selectionCmd = `command:react-compiler-marker.revealSelection?${encodeURIComponent(
      JSON.stringify({
        uri: documentUri,
        start: { line: resolvedStart, character: startChar },
        end: { line: resolvedEnd, character: endChar },
      })
    )}`;
    hoverMarkdown += fmt.link(lineText, selectionCmd);
  }

  return hoverMarkdown;
}

function buildSkippedHoverMarkdown(marker: CompilerMarker): string {
  return marker.skipReason ?? "This component was skipped by React Compiler.";
}

export function buildHoverMarkdown(marker: CompilerMarker, documentUri: string): string {
  if (marker.kind === "skipped") {
    return buildSkippedHoverMarkdown(marker);
  }
  return marker.kind === "success"
    ? buildSuccessHoverMarkdown(documentUri)
    : buildErrorHoverMarkdown(marker, documentUri);
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n-{3,}\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function codeLensTooltipForMarker(marker: CompilerMarker, documentUri: string): string {
  if (marker.kind === "success") {
    return markdownToPlainText(buildSuccessHoverMarkdown(documentUri));
  }

  const lines = ["This component will not be auto-memoized by React Compiler."];
  if (marker.errorReason) {
    lines.push("", `Error: ${marker.errorReason}`);
  }
  if (marker.errorDescription) {
    lines.push("", marker.errorDescription);
  }
  lines.push("", "Click to show compiler error details.");
  return lines.join("\n");
}
