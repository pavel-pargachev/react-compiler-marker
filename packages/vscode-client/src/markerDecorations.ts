import type { CompilerMarker } from "@react-compiler-marker/shared";
import { MARKERS_CHANGED, MARKER_REQUEST } from "@react-compiler-marker/shared";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import {
  buildHoverMarkdown,
  codeLensTooltipForMarker,
  VIRTUAL_USE_MEMO_LABEL,
} from "./markerPresentation";
import { isReactDocument, REACT_DOCUMENT_SELECTOR } from "./reactDocuments";

const USE_MEMO_GRAY = "#8a8a8a";
const USE_MEMO_ERROR_RED = "#f14c4c";

function errorCodeLensTitle(label: string): string {
  return `$(error) ${label}`;
}

function createHoverMessage(markdown: string): vscode.MarkdownString {
  const hoverMessage = new vscode.MarkdownString(markdown);
  hoverMessage.isTrusted = true;
  return hoverMessage;
}

function toSourceDecorationOptions(marker: CompilerMarker): vscode.DecorationOptions {
  const start = new vscode.Position(marker.startLine, marker.startCharacter);
  const end = new vscode.Position(marker.endLine, marker.endCharacter);

  return {
    range: new vscode.Range(start, end),
  };
}

function codeLensRangeForMarker(
  document: vscode.TextDocument,
  marker: CompilerMarker
): vscode.Range | null {
  const line = marker.codeLensLine;
  if (line === undefined || line < 0 || line >= document.lineCount) {
    return null;
  }
  return new vscode.Range(line, 0, line, 0);
}

function markerPositionMatchKind(marker: CompilerMarker, position: vscode.Position): string | null {
  if (marker.virtual) {
    return null;
  }

  const start = new vscode.Position(marker.startLine, marker.startCharacter);
  const end = new vscode.Position(marker.endLine, marker.endCharacter);
  return position.isAfterOrEqual(start) && position.isBeforeOrEqual(end) ? "sourceRange" : null;
}

function markerErrorRange(marker: CompilerMarker): vscode.Range {
  const startLine = marker.errorStartLine ?? marker.startLine;
  const startCharacter = marker.errorStartCharacter ?? marker.startCharacter;
  const endLine = marker.errorEndLine ?? marker.endLine;
  const endCharacter = marker.errorEndCharacter ?? marker.endCharacter;
  const start = new vscode.Position(startLine, startCharacter);
  let end = new vscode.Position(endLine, endCharacter);

  if (end.isBeforeOrEqual(start)) {
    end = start.translate(0, 1);
  }

  return new vscode.Range(start, end);
}

function diagnosticFromMarker(marker: CompilerMarker): vscode.Diagnostic {
  const message = marker.errorDescription
    ? `${marker.errorReason ?? "React Compiler error"}\n\n${marker.errorDescription}`
    : marker.errorReason ?? "React Compiler error";
  const diagnostic = new vscode.Diagnostic(
    markerErrorRange(marker),
    message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = "React Compiler";
  return diagnostic;
}

export class MarkerDecorationManager implements vscode.Disposable {
  private readonly sourceSuccessDecorationType: vscode.TextEditorDecorationType;
  private readonly sourceSkippedDecorationType: vscode.TextEditorDecorationType;
  private readonly sourceErrorDecorationType: vscode.TextEditorDecorationType;
  private readonly diagnosticCollection =
    vscode.languages.createDiagnosticCollection("react-compiler-marker");
  private readonly codeLensesChangedEmitter = new vscode.EventEmitter<void>();
  private readonly markersByUri = new Map<string, CompilerMarker[]>();
  private readonly pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();
  private isActivated = true;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly client: LanguageClient) {
    this.sourceSuccessDecorationType = vscode.window.createTextEditorDecorationType({
      color: USE_MEMO_GRAY,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.sourceSkippedDecorationType = vscode.window.createTextEditorDecorationType({
      color: USE_MEMO_GRAY,
      textDecoration: "line-through",
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.sourceErrorDecorationType = vscode.window.createTextEditorDecorationType({
      color: USE_MEMO_ERROR_RED,
      textDecoration: "line-through",
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.disposables.push(
      this.sourceSuccessDecorationType,
      this.sourceSkippedDecorationType,
      this.sourceErrorDecorationType,
      this.diagnosticCollection,
      this.codeLensesChangedEmitter,
      vscode.languages.registerCodeLensProvider(REACT_DOCUMENT_SELECTOR, {
        onDidChangeCodeLenses: this.codeLensesChangedEmitter.event,
        provideCodeLenses: (document) => this.provideCodeLenses(document),
      }),
      vscode.languages.registerHoverProvider(REACT_DOCUMENT_SELECTOR, {
        provideHover: (document, position) => this.provideHover(document, position),
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (isReactDocument(document)) {
          void this.scheduleRefresh(document.uri);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isReactDocument(event.document)) {
          void this.scheduleRefresh(event.document.uri);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && isReactDocument(editor.document)) {
          void this.scheduleRefresh(editor.document.uri);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cancelPendingRefresh(document.uri);
        this.markersByUri.delete(document.uri.toString());
        this.diagnosticCollection.delete(document.uri);
        this.codeLensesChangedEmitter.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("reactCompilerMarker")) {
          void this.refreshAllOpenDocuments();
        }
      }),
      this.client.onNotification(MARKERS_CHANGED, (params: { uri?: string }) => {
        if (params.uri) {
          void this.scheduleRefresh(vscode.Uri.parse(params.uri));
          return;
        }
        void this.refreshAllOpenDocuments();
      })
    );
  }

  private provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const cachedMarkers = this.markersByUri.get(document.uri.toString()) ?? [];
    const markers = cachedMarkers.filter(
      (marker) => marker.virtual && marker.codeLensLine !== undefined
    );

    const lenses: vscode.CodeLens[] = [];

    for (const marker of markers) {
      const range = codeLensRangeForMarker(document, marker);
      if (!range) {
        continue;
      }

      const label = VIRTUAL_USE_MEMO_LABEL;
      const title = marker.kind === "error" ? errorCodeLensTitle(label) : label;
      const errorRange = markerErrorRange(marker);
      const command =
        marker.kind === "error"
          ? {
              title,
              command: "react-compiler-marker.revealSelection",
              arguments: [
                {
                  uri: document.uri.toString(),
                  start: {
                    line: errorRange.start.line,
                    character: errorRange.start.character,
                  },
                  end: {
                    line: errorRange.end.line,
                    character: errorRange.end.character,
                  },
                },
              ],
              tooltip: codeLensTooltipForMarker(marker, document.uri.toString()),
            }
          : {
              title,
              command: "react-compiler-marker.previewCompiled",
              arguments: [{ uri: document.uri.toString() }],
              tooltip: codeLensTooltipForMarker(marker, document.uri.toString()),
            };
      lenses.push(
        new vscode.CodeLens(range, command)
      );
    }

    return lenses;
  }

  private provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const markers = this.markersByUri.get(document.uri.toString()) ?? [];
    const match = markers.find((marker) => markerPositionMatchKind(marker, position));

    if (!match) {
      return undefined;
    }

    return new vscode.Hover(
      createHoverMessage(buildHoverMarkdown(match, document.uri.toString()))
    );
  }

  setActivated(activated: boolean): void {
    this.isActivated = activated;
    if (!activated) {
      this.cancelPendingRefresh();
      this.markersByUri.clear();
      this.diagnosticCollection.clear();
      this.applyDecorations();
      return;
    }
    void this.refreshAllOpenDocuments();
  }

  refreshEditor(editor: vscode.TextEditor): void {
    void this.scheduleRefresh(editor.document.uri);
  }

  refreshAllOpenDocuments(): Promise<void> {
    return Promise.all(
      vscode.workspace.textDocuments.filter(isReactDocument).map((document) => this.refresh(document.uri))
    ).then(() => undefined);
  }

  dispose(): void {
    this.cancelPendingRefresh();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private cancelPendingRefresh(uri?: vscode.Uri): void {
    if (uri) {
      const key = uri.toString();
      const timer = this.pendingRefresh.get(key);
      if (timer) {
        clearTimeout(timer);
        this.pendingRefresh.delete(key);
      }
      return;
    }

    for (const timer of this.pendingRefresh.values()) {
      clearTimeout(timer);
    }
    this.pendingRefresh.clear();
  }

  private scheduleRefresh(uri: vscode.Uri, delayMs = 300): Promise<void> {
    const key = uri.toString();
    const existing = this.pendingRefresh.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        this.pendingRefresh.delete(key);
        await this.refresh(uri);
        resolve();
      }, delayMs);
      this.pendingRefresh.set(key, timer);
    });
  }

  private async refresh(uri: vscode.Uri): Promise<void> {
    if (!this.isActivated || !this.client.isRunning()) {
      this.markersByUri.delete(uri.toString());
      this.diagnosticCollection.delete(uri);
      this.applyDecorations();
      return;
    }

    try {
      const markers = await this.client.sendRequest<CompilerMarker[] | null>(MARKER_REQUEST, {
        uri: uri.toString(),
      });
      if (!this.isActivated || !this.client.isRunning()) {
        this.markersByUri.delete(uri.toString());
        this.diagnosticCollection.delete(uri);
      } else {
        this.markersByUri.set(uri.toString(), markers ?? []);
        this.updateDiagnostics(uri, markers ?? []);
      }
    } catch {
      this.markersByUri.delete(uri.toString());
      this.diagnosticCollection.delete(uri);
    }

    this.applyDecorations();
  }

  private applyDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const markers = this.markersByUri.get(editor.document.uri.toString()) ?? [];

      const sourceSuccess = markers
        .filter((marker) => marker.kind === "success" && !marker.virtual)
        .map(toSourceDecorationOptions);
      const sourceSkipped = markers
        .filter((marker) => marker.kind === "skipped" && !marker.virtual)
        .map(toSourceDecorationOptions);
      const sourceError = markers
        .filter((marker) => marker.kind === "error" && !marker.virtual)
        .map(toSourceDecorationOptions);

      editor.setDecorations(this.sourceSuccessDecorationType, sourceSuccess);
      editor.setDecorations(this.sourceSkippedDecorationType, sourceSkipped);
      editor.setDecorations(this.sourceErrorDecorationType, sourceError);
    }

    this.codeLensesChangedEmitter.fire();
  }

  private updateDiagnostics(uri: vscode.Uri, markers: CompilerMarker[]): void {
    const diagnostics = markers
      .filter((marker) => marker.kind === "error")
      .map(diagnosticFromMarker);

    this.diagnosticCollection.set(uri, diagnostics);
  }
}
