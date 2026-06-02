import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  COMPILED_PREVIEW_INFIX,
  COMPILED_PREVIEW_SCHEME,
  getCompiledPreviewUri,
  getSourceUriForCompiledPreview,
  isCompiledPreviewUri,
} from "../src/compiledPreview";

suite("Compiled preview URIs", () => {
  test("maps a source file to an in-memory preview URI and back", () => {
    const source = vscode.Uri.file(path.join("C:", "proj", "src", "App.tsx"));
    const preview = getCompiledPreviewUri(source);

    assert.ok(preview);
    assert.strictEqual(preview!.scheme, COMPILED_PREVIEW_SCHEME);
    assert.ok(preview!.path.endsWith(`App${COMPILED_PREVIEW_INFIX}.tsx`));
    assert.ok(isCompiledPreviewUri(preview!));

    const roundTrip = getSourceUriForCompiledPreview(preview!);
    assert.ok(roundTrip);
    assert.strictEqual(roundTrip!.toString(), source.toString());
  });

  test("uses distinct preview paths for same-named files in different folders", () => {
    const srcApp = vscode.Uri.file(path.join("C:", "proj", "src", "App.tsx"));
    const libApp = vscode.Uri.file(path.join("C:", "proj", "lib", "App.tsx"));
    const previewSrc = getCompiledPreviewUri(srcApp)!;
    const previewLib = getCompiledPreviewUri(libApp)!;

    assert.notStrictEqual(previewSrc.path, previewLib.path);
    assert.notStrictEqual(previewSrc.toString(), previewLib.toString());
    assert.strictEqual(getSourceUriForCompiledPreview(previewSrc)!.fsPath, srcApp.fsPath);
    assert.strictEqual(getSourceUriForCompiledPreview(previewLib)!.fsPath, libApp.fsPath);
  });

  test("does not treat unrelated files as previews", () => {
    const uri = vscode.Uri.file(path.join("C:", "proj", "src", "App.tsx"));
    assert.strictEqual(isCompiledPreviewUri(uri), false);
    assert.strictEqual(getSourceUriForCompiledPreview(uri), undefined);
  });
});
