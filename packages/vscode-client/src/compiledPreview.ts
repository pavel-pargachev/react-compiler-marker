import * as path from "path";
import * as vscode from "vscode";

export const COMPILED_PREVIEW_SCHEME = "react-compiler-preview";

/** Separate scheme so format-scratch updates never refresh the visible preview tab. */
const FORMAT_SCRATCH_SCHEME = "react-compiler-format-scratch";

/** Display suffix: `App.tsx` → `App.react-compiler-preview.tsx` */
export const COMPILED_PREVIEW_INFIX = ".react-compiler-preview";

const SYNC_DEBOUNCE_MS = 400;

export type GetCompiledOutput = (
  sourceUri: string
) => Promise<{ success: boolean; code?: string; error?: string }>;

export function isCompiledPreviewUri(uri: vscode.Uri): boolean {
  return uri.scheme === COMPILED_PREVIEW_SCHEME;
}

/** Unique virtual path per source file (tab identity ignores the `source` query). */
export function getPreviewDocumentPath(sourceUri: vscode.Uri): string {
  const relativePath = vscode.workspace.asRelativePath(sourceUri, false);
  const posixPath = relativePath.replace(/\\/g, "/");
  const parsed = path.posix.parse(posixPath);
  const previewFileName = `${parsed.name}${COMPILED_PREVIEW_INFIX}${parsed.ext}`;
  const segments = parsed.dir ? parsed.dir.split("/").filter(Boolean) : [];
  segments.push(previewFileName);
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function getCompiledPreviewUri(sourceUri: vscode.Uri): vscode.Uri | undefined {
  if (sourceUri.scheme !== "file") {
    return undefined;
  }

  return vscode.Uri.from({
    scheme: COMPILED_PREVIEW_SCHEME,
    path: getPreviewDocumentPath(sourceUri),
    query: `source=${encodeURIComponent(sourceUri.toString())}`,
  });
}

export function getSourceUriForCompiledPreview(previewUri: vscode.Uri): vscode.Uri | undefined {
  if (!isCompiledPreviewUri(previewUri)) {
    return undefined;
  }

  const source = new URLSearchParams(previewUri.query).get("source");
  if (!source) {
    return undefined;
  }

  return vscode.Uri.parse(source);
}

function applyTextEdits(
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[]
): string {
  const ordered = [...edits].sort(
    (a, b) =>
      b.range.start.line - a.range.start.line ||
      b.range.start.character - a.range.start.character
  );
  let text = document.getText();
  for (const edit of ordered) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    text = text.slice(0, start) + edit.newText + text.slice(end);
  }
  return text;
}

class InMemoryReadonlyFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Uint8Array>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const content = this.files.get(uri.toString());
    if (!content) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: content.byteLength,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.FileNotFound();
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const content = this.files.get(uri.toString());
    if (!content) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return content;
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only.");
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only.");
  }

  delete(uri: vscode.Uri): void {
    if (!this.files.delete(uri.toString())) {
      return;
    }
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only.");
  }

  setContent(uri: vscode.Uri, text: string): void {
    const key = uri.toString();
    const existed = this.files.has(key);
    this.files.set(key, Buffer.from(text, "utf8"));
    this.changeEmitter.fire([
      {
        type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }
}

export class CompiledPreviewManager implements vscode.Disposable {
  private readonly previewFileSystem = new InMemoryReadonlyFileSystem();
  private readonly formatFileSystem = new InMemoryReadonlyFileSystem();
  private readonly openSourceUris = new Set<string>();
  private readonly formatLanguageByUri = new Map<string, string>();
  private readonly syncGenerationBySource = new Map<string, number>();
  private readonly pendingSync = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private formatScratchCounter = 0;

  constructor(private readonly getCompiledOutput: GetCompiledOutput) {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(
        COMPILED_PREVIEW_SCHEME,
        this.previewFileSystem,
        { isReadonly: true, isCaseSensitive: true }
      ),
      vscode.workspace.registerFileSystemProvider(FORMAT_SCRATCH_SCHEME, this.formatFileSystem, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.openSourceUris.has(event.document.uri.toString())) {
          return;
        }
        this.scheduleSync(event.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (!isCompiledPreviewUri(document.uri)) {
          return;
        }

        const sourceUri = getSourceUriForCompiledPreview(document.uri);
        if (sourceUri) {
          const sourceKey = sourceUri.toString();
          this.openSourceUris.delete(sourceKey);
          this.syncGenerationBySource.delete(sourceKey);
        }

        this.formatLanguageByUri.delete(document.uri.toString());
        this.previewFileSystem.delete(document.uri);
      })
    );
  }

  dispose(): void {
    for (const timeout of this.pendingSync.values()) {
      clearTimeout(timeout);
    }
    this.pendingSync.clear();
    this.openSourceUris.clear();
    this.formatLanguageByUri.clear();
    this.syncGenerationBySource.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async formatCompiledCode(code: string, languageId: string): Promise<string> {
    const scratchUri = vscode.Uri.from({
      scheme: FORMAT_SCRATCH_SCHEME,
      path: `/__format-scratch__/${++this.formatScratchCounter}.tsx`,
    });

    this.formatFileSystem.setContent(scratchUri, code);

    try {
      const scratch = await vscode.workspace.openTextDocument(scratchUri);
      if (scratch.getText() !== code) {
        return code;
      }

      if (scratch.languageId !== languageId) {
        await vscode.languages.setTextDocumentLanguage(scratch, languageId);
      }

      const options: vscode.FormattingOptions = {
        insertSpaces: true,
        tabSize: languageId.startsWith("typescript") ? 2 : 2,
      };

      const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
        "vscode.executeFormatDocumentProvider",
        scratchUri,
        options
      );

      if (!edits?.length) {
        return code;
      }

      return applyTextEdits(scratch, edits);
    } finally {
      this.formatFileSystem.delete(scratchUri);
    }
  }

  async open(source: vscode.TextDocument): Promise<void> {
    const previewUri = getCompiledPreviewUri(source.uri);
    if (!previewUri) {
      throw new Error("Compiled preview is only available for saved files on disk.");
    }

    const sourceKey = source.uri.toString();
    this.openSourceUris.add(sourceKey);
    this.formatLanguageByUri.set(previewUri.toString(), source.languageId);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "React Compiler: Compiling preview...",
          cancellable: false,
        },
        async () => {
          await this.writePreview(source.uri, previewUri, source.languageId);

          const existingEditor = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === previewUri.toString()
          );
          if (existingEditor) {
            await this.showPreviewEditor(existingEditor.document);
            return;
          }

          const previewDocument = await vscode.workspace.openTextDocument(previewUri);
          await this.showPreviewEditor(previewDocument);
        }
      );
    } catch (error) {
      if (!vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === previewUri.toString())) {
        this.openSourceUris.delete(sourceKey);
        this.formatLanguageByUri.delete(previewUri.toString());
        this.previewFileSystem.delete(previewUri);
      }
      throw error;
    }
  }

  private async showPreviewEditor(document: vscode.TextDocument): Promise<void> {
    await vscode.window.showTextDocument(document, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    });
  }

  private scheduleSync(sourceUri: vscode.Uri): void {
    const key = sourceUri.toString();
    const existing = this.pendingSync.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    this.pendingSync.set(
      key,
      setTimeout(() => {
        this.pendingSync.delete(key);
        void this.syncFromSource(sourceUri);
      }, SYNC_DEBOUNCE_MS)
    );
  }

  private async syncFromSource(sourceUri: vscode.Uri): Promise<void> {
    if (!this.openSourceUris.has(sourceUri.toString())) {
      return;
    }

    const previewUri = getCompiledPreviewUri(sourceUri);
    if (!previewUri) {
      return;
    }

    const languageId = this.formatLanguageByUri.get(previewUri.toString());
    if (!languageId) {
      return;
    }

    try {
      await this.writePreview(sourceUri, previewUri, languageId);
    } catch {
      // Compilation can fail transiently while typing; keep the last good preview.
    }
  }

  private async writePreview(
    sourceUri: vscode.Uri,
    previewUri: vscode.Uri,
    languageId: string
  ): Promise<void> {
    const sourceKey = sourceUri.toString();
    const generation = (this.syncGenerationBySource.get(sourceKey) ?? 0) + 1;
    this.syncGenerationBySource.set(sourceKey, generation);

    const result = await this.getCompiledOutput(sourceKey);
    if (this.syncGenerationBySource.get(sourceKey) !== generation) {
      return;
    }

    if (!result.success || !result.code) {
      throw new Error(result.error || "Compilation failed");
    }

    const formatted = await this.formatCompiledCode(result.code, languageId);
    if (this.syncGenerationBySource.get(sourceKey) !== generation) {
      return;
    }

    this.previewFileSystem.setContent(previewUri, formatted);
  }
}
