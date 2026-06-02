import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  ExecuteCommandParams,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath } from "node:url";
import {
  checkReactCompiler,
  getCompiledOutput,
  clearPluginCache,
  clearCompilationCache,
} from "./checkReactCompiler";
import { clearReactCompilerConfigCache } from "./reactCompilerConfig";
import {
  DEFAULT_BABEL_PLUGIN_PATH,
  DEFAULT_REACT_COMPILER_CONFIG_FILE,
  MARKERS_CHANGED,
  MARKER_REQUEST,
  isReactLanguageId,
} from "@react-compiler-marker/shared";
import { generateMarkers } from "./markers";

import packageJson from "../package.json";
const { version } = packageJson;

// Create a connection for the server (Node IPC, started by the VS Code language client)
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Store settings
interface Settings {
  babelPluginPath: string;
  configFile: string;
}

let globalSettings: Settings = {
  babelPluginPath: DEFAULT_BABEL_PLUGIN_PATH,
  configFile: DEFAULT_REACT_COMPILER_CONFIG_FILE,
};

// Store activation state (synced from client initializationOptions)
let isActivated = true;

interface ClientInitializationOptions {
  isActivated?: boolean;
}

let workspaceFolders: string[] = [];
let hasWorkspaceFolderCapability = false;

// Store client name
let clientName: string | undefined;

function logMessage(message: string): void {
  const timestamp = new Date().toISOString();
  connection.console.log(`[${timestamp}] SERVER LOG: ${message}`);
}

function logError(error: string): void {
  const timestamp = new Date().toISOString();
  connection.console.error(`[${timestamp}] SERVER ERROR: ${error}`);
}

function notifyMarkersChanged(uri?: string): void {
  connection.sendNotification(MARKERS_CHANGED, { uri });
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function workspaceFolderUriToPath(uri: string): string | undefined {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return undefined;
}

function syncWorkspaceFoldersFromUris(uris: string[]): void {
  workspaceFolders = uris
    .map(workspaceFolderUriToPath)
    .filter((path): path is string => path !== undefined);
}

function getWorkspaceFolderForUri(uri: string): string | undefined {
  if (workspaceFolders.length === 0) {
    return undefined;
  }

  const filePath = uriToFileName(uri);
  const normalizedFile = normalizePath(filePath);

  let best: string | undefined;
  for (const folder of workspaceFolders) {
    const normalizedFolder = normalizePath(folder);
    if (
      normalizedFile === normalizedFolder ||
      normalizedFile.startsWith(`${normalizedFolder}/`)
    ) {
      if (!best || normalizedFolder.length > normalizePath(best).length) {
        best = folder;
      }
    }
  }

  return best;
}

function uriToFileName(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  return fileURLToPath(uri);
}

interface DocumentProcessContext {
  document: TextDocument;
  fileName: string;
  workspaceFolder: string;
}

function getDocumentProcessContext(uri: string): DocumentProcessContext | null {
  if (!isActivated) {
    return null;
  }

  if (!uri.startsWith("file://")) {
    return null;
  }

  const folder = getWorkspaceFolderForUri(uri);
  if (!folder) {
    return null;
  }

  const document = documents.get(uri);
  if (!document) {
    return null;
  }

  if (!isReactLanguageId(document.languageId)) {
    return null;
  }

  return {
    document,
    fileName: uriToFileName(uri),
    workspaceFolder: folder,
  };
}

function computeMarkers(document: TextDocument, folder: string) {
  const fileNameForCompiler = uriToFileName(document.uri);
  const sourceCode = document.getText();

  const { successfulCompilations, failedCompilations, skippedCompilations } = checkReactCompiler(
    sourceCode,
    fileNameForCompiler,
    folder,
    globalSettings.babelPluginPath,
    globalSettings.configFile
  );

  return generateMarkers(
    document,
    successfulCompilations,
    failedCompilations,
    skippedCompilations
  );
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasWorkspaceFolderCapability = !!params.capabilities.workspace?.workspaceFolders;

  if (params.workspaceFolders) {
    syncWorkspaceFoldersFromUris(params.workspaceFolders.map((folder) => folder.uri));
  }

  clientName = params.clientInfo?.name;

  const initOptions = params.initializationOptions as ClientInitializationOptions | undefined;
  if (typeof initOptions?.isActivated === "boolean") {
    isActivated = initOptions.isActivated;
  }

  logMessage(
    `Client connected: ${clientName ?? "Unknown"} ${params.clientInfo?.version ?? ""} (activated: ${isActivated})`
  );

  const result: InitializeResult = {
    serverInfo: {
      name: "React Compiler Marker LSP",
      version,
    },
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      executeCommandProvider: {
        commands: [
          "react-compiler-marker/activate",
          "react-compiler-marker/deactivate",
          "react-compiler-marker/getCompiledOutput",
          "react-compiler-marker/checkOnce",
          "react-compiler-marker/reloadReactCompilerConfig",
        ],
      },
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  return result;
});

connection.onInitialized(() => {
  logMessage("React Compiler Marker LSP Server initialized");

  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        const path = workspaceFolderUriToPath(folder.uri);
        if (path) {
          const normalized = normalizePath(path);
          workspaceFolders = workspaceFolders.filter((f) => normalizePath(f) !== normalized);
        }
      }
      for (const folder of event.added) {
        const path = workspaceFolderUriToPath(folder.uri);
        if (path && !workspaceFolders.some((f) => normalizePath(f) === normalizePath(path))) {
          workspaceFolders.push(path);
        }
      }
      logMessage(`Workspace folders updated: ${workspaceFolders.length} folder(s)`);
      notifyMarkersChanged();
    });
  }
});

// Handle configuration changes
connection.onDidChangeConfiguration((change) => {
  const settings = change.settings?.reactCompilerMarker;
  if (settings) {
    const oldBabelPluginPath = globalSettings.babelPluginPath;
    const oldConfigFile = globalSettings.configFile;
    globalSettings = {
      babelPluginPath: settings.babelPluginPath ?? DEFAULT_BABEL_PLUGIN_PATH,
      configFile: settings.configFile ?? DEFAULT_REACT_COMPILER_CONFIG_FILE,
    };

    // Clear caches if babel plugin path changed
    if (oldBabelPluginPath !== globalSettings.babelPluginPath) {
      clearPluginCache();
      clearCompilationCache();
    }

    if (oldConfigFile !== globalSettings.configFile) {
      clearReactCompilerConfigCache();
      clearCompilationCache();
    }
  }
  notifyMarkersChanged();
});

connection.onRequest(MARKER_REQUEST, async (params: { uri: string }) => {
  const context = getDocumentProcessContext(params.uri);
  if (!context) {
    return null;
  }

  logMessage(`Process markers for ${params.uri}`);
  try {
    return computeMarkers(context.document, context.workspaceFolder);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`Error checking React Compiler: ${message}`);
    return [];
  }
});

// Handle execute command
connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  switch (params.command) {
    case "react-compiler-marker/activate":
      isActivated = true;
      notifyMarkersChanged();
      return { success: true, activated: true };

    case "react-compiler-marker/deactivate":
      isActivated = false;
      notifyMarkersChanged();
      return { success: true, activated: false };

    case "react-compiler-marker/getCompiledOutput": {
      const [uri] = params.arguments ?? [];
      if (!uri || typeof uri !== "string") {
        return { success: false, error: "No URI provided" };
      }

      const context = getDocumentProcessContext(uri);
      if (!context) {
        return {
          success: false,
          error:
            "Document is not available for compilation (save the file, open a workspace, or activate the extension)",
        };
      }

      try {
        const compiled = await getCompiledOutput(
          context.document.getText(),
          context.fileName,
          context.workspaceFolder,
          globalSettings.babelPluginPath,
          globalSettings.configFile
        );
        return { success: true, code: compiled };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }

    case "react-compiler-marker/checkOnce": {
      notifyMarkersChanged();
      return { success: true };
    }

    case "react-compiler-marker/reloadReactCompilerConfig": {
      clearReactCompilerConfigCache();
      clearCompilationCache();
      notifyMarkersChanged();
      return { success: true };
    }

    default:
      return { success: false, error: "Unknown command" };
  }
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
