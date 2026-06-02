import { isReactLanguageId, REACT_LANGUAGE_IDS } from "@react-compiler-marker/shared";
import * as vscode from "vscode";

export const REACT_DOCUMENT_SELECTOR: vscode.DocumentFilter[] = REACT_LANGUAGE_IDS.map(
  (language): vscode.DocumentFilter => ({ scheme: "file", language })
);

export function isReactDocument(document: vscode.TextDocument): boolean {
  return isReactLanguageId(document.languageId);
}
