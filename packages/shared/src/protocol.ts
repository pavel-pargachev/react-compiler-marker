export interface CompilerMarker {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  kind: "success" | "error" | "skipped";
  /** From compiler CompileSkip reason when kind is "skipped". */
  skipReason?: string;
  /** Injected label (not in source). */
  virtual?: boolean;
  /** Code Lens row above this line (reserves vertical space like "N references"). */
  codeLensLine?: number;
  errorReason?: string;
  errorDescription?: string;
  errorStartLine?: number;
  errorStartCharacter?: number;
  errorEndLine?: number;
  errorEndCharacter?: number;
}

export const MARKER_REQUEST = "react-compiler-marker/getMarkers";
export const MARKERS_CHANGED = "react-compiler-marker/markersChanged";

export const REACT_LANGUAGE_IDS = [
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
] as const;

export type ReactLanguageId = (typeof REACT_LANGUAGE_IDS)[number];

export function isReactLanguageId(languageId: string): languageId is ReactLanguageId {
  return (REACT_LANGUAGE_IDS as readonly string[]).includes(languageId);
}

export const DEFAULT_REACT_COMPILER_CONFIG_FILE = ".config/react-compiler.ts";

export const DEFAULT_BABEL_PLUGIN_PATH = "node_modules/babel-plugin-react-compiler";
