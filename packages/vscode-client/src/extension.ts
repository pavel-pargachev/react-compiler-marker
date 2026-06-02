import { DEFAULT_REACT_COMPILER_CONFIG_FILE } from "@react-compiler-marker/shared";
import * as path from "path";
import * as vscode from "vscode";
import {
  DocumentSelector,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { CompiledPreviewManager } from "./compiledPreview";
import { MarkerDecorationManager } from "./markerDecorations";
import { REACT_DOCUMENT_SELECTOR } from "./reactDocuments";

const languageClientState: {
  client: LanguageClient | undefined;
  startPromise: Promise<LanguageClient> | undefined;
} = {
  client: undefined,
  startPromise: undefined,
};

let markerDecorationManager: MarkerDecorationManager | undefined;

const outputChannel = vscode.window.createOutputChannel("React Compiler Marker");

function logMessage(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] CLIENT LOG: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type EditorRangeArgs = {
  uri?: string;
  start: { line: number; character: number };
  end: { line: number; character: number };
};

async function showEditorForUri(uri?: string): Promise<vscode.TextEditor | undefined> {
  if (!uri) {
    return vscode.window.activeTextEditor;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  return vscode.window.showTextDocument(document, { preview: false });
}

function parseEditorRange(args: EditorRangeArgs): vscode.Range | undefined {
  if (!args?.start || !args?.end) {
    return undefined;
  }

  const start = new vscode.Position(args.start.line, args.start.character);
  const end = new vscode.Position(args.end.line, args.end.character);
  return new vscode.Range(start, end);
}

async function revealEditorRange(args: EditorRangeArgs): Promise<void> {
  const editor = await showEditorForUri(args?.uri);
  if (!editor) {
    vscode.window.showErrorMessage("No active editor to reveal selection.");
    return;
  }

  const range = parseEditorRange(args);
  if (!range) {
    vscode.window.showErrorMessage("Invalid selection arguments.");
    return;
  }

  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function ensureLanguageClientReady(): Promise<LanguageClient> {
  const { startPromise } = languageClientState;
  if (!startPromise) {
    throw new Error("React Compiler Marker language client is not initialized.");
  }

  const client = await startPromise;
  if (!client.isRunning()) {
    throw new Error("React Compiler Marker language client is not running.");
  }

  return client;
}

async function executeServerCommand(command: string, args?: unknown[]): Promise<unknown> {
  const client = await ensureLanguageClientReady();
  return client.sendRequest("workspace/executeCommand", { command, arguments: args });
}

export function activate(context: vscode.ExtensionContext): void {
  logMessage("react-compiler-marker is being activated!");

  const activation = {
    isActivated: context.globalState.get<boolean>("isActivated", true),
  };

  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: REACT_DOCUMENT_SELECTOR as DocumentSelector,
    synchronize: {
      configurationSection: "reactCompilerMarker",
    },
    outputChannel,
    markdown: {
      isTrusted: true,
    },
    initializationOptions: {
      isActivated: activation.isActivated,
    },
  };

  const client = new LanguageClient(
    "reactCompilerMarker",
    "React Compiler Marker",
    serverOptions,
    clientOptions
  );
  languageClientState.client = client;

  languageClientState.startPromise = client
    .start()
    .then(() => {
      logMessage("React Compiler Marker LSP client started");

      markerDecorationManager = new MarkerDecorationManager(client);
      context.subscriptions.push(markerDecorationManager);
      markerDecorationManager.setActivated(activation.isActivated);
      void markerDecorationManager.refreshAllOpenDocuments();

      return client;
    })
    .catch((error: unknown) => {
      const message = errorMessage(error);
      logMessage(`Failed to start LSP client: ${message}`);
      void vscode.window.showErrorMessage(`React Compiler Marker failed to start: ${message}`);
      throw error;
    });

  let configWatchers: vscode.Disposable = vscode.Disposable.from();

  const updateConfigFileWatcher = () => {
    configWatchers.dispose();

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const configFile =
      vscode.workspace
        .getConfiguration("reactCompilerMarker")
        .get<string>("configFile") ?? DEFAULT_REACT_COMPILER_CONFIG_FILE;

    if (!workspaceFolders?.length) {
      configWatchers = vscode.Disposable.from();
      return;
    }

    const reloadReactCompilerConfig = () => {
      void executeServerCommand("react-compiler-marker/reloadReactCompilerConfig").catch(() => {
        // Client not ready or server unavailable.
      });
    };

    const watchers: vscode.FileSystemWatcher[] = [];
    for (const workspaceFolder of workspaceFolders) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, configFile)
      );
      watcher.onDidChange(reloadReactCompilerConfig);
      watcher.onDidCreate(reloadReactCompilerConfig);
      watcher.onDidDelete(reloadReactCompilerConfig);
      watchers.push(watcher);
    }

    configWatchers = vscode.Disposable.from(...watchers);
  };

  updateConfigFileWatcher();
  context.subscriptions.push(
    { dispose: () => configWatchers.dispose() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("reactCompilerMarker.configFile")) {
        updateConfigFileWatcher();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateConfigFileWatcher();
    })
  );

  const compiledPreviewManager = new CompiledPreviewManager(async (sourceUri) => {
    return (await executeServerCommand("react-compiler-marker/getCompiledOutput", [
      sourceUri,
    ])) as { success: boolean; code?: string; error?: string };
  });
  context.subscriptions.push(compiledPreviewManager);

  registerCommands(context, activation, compiledPreviewManager, async (value: boolean) => {
    activation.isActivated = value;
    await context.globalState.update("isActivated", value);
    markerDecorationManager?.setActivated(value);
  });

  context.subscriptions.push({
    dispose: () => {
      languageClientState.client = undefined;
      languageClientState.startPromise = undefined;
      markerDecorationManager = undefined;
    },
  });

  logMessage("React Compiler Marker: Initialization complete.");
}

function registerCommands(
  context: vscode.ExtensionContext,
  activation: { isActivated: boolean },
  compiledPreviewManager: CompiledPreviewManager,
  setIsActivated: (value: boolean) => Promise<void>
): void {
  const refreshCommand = vscode.commands.registerCommand(
    "react-compiler-marker.checkOnce",
    async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showErrorMessage("No active editor to check.");
        return;
      }

      if (!activation.isActivated) {
        vscode.window.showInformationMessage(
          "React Compiler Marker is deactivated. Activate it to refresh markers."
        );
        return;
      }

      try {
        await executeServerCommand("react-compiler-marker/checkOnce");

        const activeEditorAfterRefresh = vscode.window.activeTextEditor;
        if (activeEditorAfterRefresh) {
          markerDecorationManager?.refreshEditor(activeEditorAfterRefresh);
        }

        vscode.window.showInformationMessage("React Compiler Markers refreshed");
      } catch (error: unknown) {
        vscode.window.showErrorMessage(
          `Failed to refresh React Compiler markers: ${errorMessage(error)}`
        );
      }
    }
  );

  const activateCommand = vscode.commands.registerCommand(
    "react-compiler-marker.activate",
    async () => {
      if (activation.isActivated) {
        vscode.window.showInformationMessage("React Compiler Marker is already activated.");
        return;
      }

      try {
        await executeServerCommand("react-compiler-marker/activate");
        await setIsActivated(true);
        vscode.window.showInformationMessage("React Compiler Marker activated!");
      } catch (error: unknown) {
        vscode.window.showErrorMessage(
          `Failed to activate React Compiler Marker: ${errorMessage(error)}`
        );
      }
    }
  );

  const deactivateCommand = vscode.commands.registerCommand(
    "react-compiler-marker.deactivate",
    async () => {
      if (!activation.isActivated) {
        vscode.window.showInformationMessage("React Compiler Marker is already deactivated.");
        return;
      }

      try {
        await executeServerCommand("react-compiler-marker/deactivate");
        await setIsActivated(false);
        vscode.window.showInformationMessage("React Compiler Marker deactivated!");
      } catch (error: unknown) {
        vscode.window.showErrorMessage(
          `Failed to deactivate React Compiler Marker: ${errorMessage(error)}`
        );
      }
    }
  );

  const previewCompiled = vscode.commands.registerCommand(
    "react-compiler-marker.previewCompiled",
    async (args?: { uri?: string }) => {
      if (!activation.isActivated) {
        vscode.window.showErrorMessage(
          "React Compiler Marker is deactivated. Activate it to preview compiled output."
        );
        return;
      }

      const editor = await showEditorForUri(args?.uri);
      if (!editor) {
        vscode.window.showErrorMessage("No active editor to preview.");
        return;
      }

      const document = editor.document;
      const filename = document.fileName;

      if (!filename || document.isUntitled) {
        vscode.window.showErrorMessage("Please save the file before previewing compiled output.");
        return;
      }

      try {
        await compiledPreviewManager.open(document);
      } catch (error: unknown) {
        vscode.window.showErrorMessage(
          `Failed to compile the current file: ${errorMessage(error)}`
        );
      }
    }
  );

  const revealSelectionCmd = vscode.commands.registerCommand(
    "react-compiler-marker.revealSelection",
    (args: EditorRangeArgs) => revealEditorRange(args)
  );

  context.subscriptions.push(
    refreshCommand,
    activateCommand,
    deactivateCommand,
    previewCompiled,
    revealSelectionCmd
  );

  logMessage("React Compiler Marker: Commands registered.");
}

export function deactivate(): Thenable<void> | undefined {
  logMessage("React Compiler Marker deactivating...");
  const client = languageClientState.client;
  languageClientState.client = undefined;
  languageClientState.startPromise = undefined;
  markerDecorationManager = undefined;
  if (!client) {
    return undefined;
  }
  return client.stop();
}
