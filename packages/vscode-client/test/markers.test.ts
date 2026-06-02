import type { CompilerMarker } from "@react-compiler-marker/shared";
import * as assert from "assert";
import * as path from "path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { compileFixture, readFixture } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateMarkers } = require(path.join(__dirname, "..", "..", "..", "server", "out", "markers"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildReactCompilerIncludeRegExp } = require(path.join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "out",
  "reactCompilerConfig"
));

function pathMatchesReactCompiler(paths: string[], normalizedPath: string): boolean {
  const include = buildReactCompilerIncludeRegExp(paths);
  return include ? include.test(normalizedPath.replace(/\\/g, "/")) : false;
}

function markerCoversUseMemo(document: TextDocument, marker: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }): boolean {
  const text = document.getText({
    start: { line: marker.startLine, character: marker.startCharacter },
    end: { line: marker.endLine, character: marker.endCharacter },
  });
  return /(['"])use memo\1/.test(text);
}

function markerCoversUseNoMemo(document: TextDocument, marker: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }): boolean {
  const text = document.getText({
    start: { line: marker.startLine, character: marker.startCharacter },
    end: { line: marker.endLine, character: marker.endCharacter },
  });
  return /(['"])use no memo\1/.test(text);
}

suite("reactCompilerPaths matching", () => {
  test("matches path substrings like Babel override test RegExp", () => {
    assert.ok(pathMatchesReactCompiler(["src"], "src/App.tsx"));
    assert.ok(pathMatchesReactCompiler(["src"], "src/features/ui/Button.tsx"));
    assert.ok(pathMatchesReactCompiler(["src"], "lib/src/App.tsx"));
  });

  test("joins multiple patterns with alternation", () => {
    assert.ok(pathMatchesReactCompiler(["src/features", "packages/app"], "src/features/App.tsx"));
    assert.ok(
      pathMatchesReactCompiler(["src/features", "packages/app"], "packages/app/index.tsx")
    );
    assert.strictEqual(
      pathMatchesReactCompiler(["src/features", "packages/app"], "lib/other.tsx"),
      false
    );
  });

  test("treats slashes like Babel ([\\/] in the RegExp source)", () => {
    const include = buildReactCompilerIncludeRegExp(["src/features"]);
    assert.ok(include.test("src/features/App.tsx"));
    assert.ok(include.test("src\\features\\App.tsx"));
  });

  test("empty paths do not match", () => {
    assert.strictEqual(pathMatchesReactCompiler([], "src/App.tsx"), false);
  });
});

suite("Marker positioning", () => {
  test('local "use memo" highlights the directive in source', () => {
    const text = readFixture("annotation-mode.tsx");
    const document = TextDocument.create("file:///mock/annotation-mode.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(
      text,
      "/mock/annotation-mode.tsx",
      "react-compiler-annotation.cjs"
    );

    const optedIn = successfulCompilations.find((log: { fnName?: string }) => log.fnName === "OptedInComponent");
    assert.ok(optedIn, "Expected OptedInComponent compilation");

    const markers = generateMarkers(document, [optedIn], []);
    assert.strictEqual(markers.length, 1);
    assert.ok(!markers[0].virtual, "Expected in-source directive highlight");
    assert.ok(markerCoversUseMemo(document, markers[0]));
    assert.strictEqual(markers[0].startLine, 4);
  });

  test("compiled components without an in-body directive get a code lens on the first body line", () => {
    const text = readFixture("export-named-function.tsx");
    const document = TextDocument.create("file:///mock/export-named-function.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/export-named-function.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].virtual, true);
    assert.strictEqual(markers[0].codeLensLine, 3, "First body line (return), not the declaration line");
  });

  test("multiline declarations place the virtual label after the opening brace line", () => {
    const text = `import React from "react";

export function Component(
  props: { name: string },
) {
  return <div>{props.name}</div>;
}`;
    const document = TextDocument.create("file:///mock/multiline.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/multiline.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].codeLensLine, 5, "Line with return, after multiline header and brace line");
  });

  test("one-liner at file end gets a code lens on the component line", () => {
    const text = `import React from "react";

export const Widget = () => <span />;`;
    const document = TextDocument.create("file:///mock/one-liner.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/one-liner.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].virtual, true);
    assert.strictEqual(markers[0].codeLensLine, 2);
  });

  test("code lens targets the component, not nested arrow functions", () => {
    const text = `import React from "react";

export function Card() {
  const onClick = () => {
    console.log("click");
  };
  return <button onClick={onClick} />;
}`;
    const document = TextDocument.create("file:///mock/nested-arrows.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/nested-arrows.tsx");

    const card = successfulCompilations.find(
      (log: { fnName?: string }) => log.fnName === "Card"
    );
    assert.ok(card, "Expected Card compilation");

    const markers = generateMarkers(document, [card], []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].virtual, true);
    assert.notStrictEqual(
      markers[0].codeLensLine,
      4,
      "Should not anchor to the nested onClick arrow body"
    );
    assert.strictEqual(markers[0].codeLensLine, 3, "First statement of the component body");
  });

  test("arrow with brace on the next line places the code lens on the first body line", () => {
    const text = `import React from "react";

export const ComponentX = () =>
{
    return <></>
};`;
    const document = TextDocument.create("file:///mock/arrow-block-next-line.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/arrow-block-next-line.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].virtual, true);
    assert.strictEqual(markers[0].codeLensLine, 4, "Line with return, not the opening brace");
  });

  test("multiline concise arrow places the code lens on the expression line", () => {
    const text = `import React from "react";

export const ComponentX
 =
  () =>
     <></>;`;
    const document = TextDocument.create("file:///mock/multiline-arrow.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/multiline-arrow.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].virtual, true);
    assert.strictEqual(markers[0].codeLensLine, 5, "Line with JSX, not the => line");
  });

  test("one-liner with a trailing line keeps the code lens on the declaration line", () => {
    const text = `import React from "react";

export const Widget = () => <span />;

`;
    const document = TextDocument.create("file:///mock/one-liner-trailing.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/one-liner-trailing.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].codeLensLine, 2);
  });

  test("annotation-mode files without a directive do not get virtual labels", () => {
    const text = readFixture("annotation-mode.tsx");
    const document = TextDocument.create("file:///mock/annotation-mode.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(
      text,
      "/mock/annotation-mode.tsx",
      "react-compiler-annotation.cjs"
    );

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1, "Only the opted-in component should be marked");
  });

  test('file-level "use memo" still gets a virtual label on the first body line', () => {
    const text = `'use memo';

export function FileLevelComponent() {
  return <div>Hello</div>;
}`;
    const document = TextDocument.create("file:///mock/file-level.tsx", "typescriptreact", 1, text);
    const { successfulCompilations } = compileFixture(text, "/mock/file-level.tsx");

    const markers = generateMarkers(document, successfulCompilations, []);
    assert.strictEqual(markers.length, 1);

    assert.strictEqual(markers[0].virtual, true);
    assert.strictEqual(markers[0].codeLensLine, 3);
    assert.notStrictEqual(markers[0].codeLensLine, 0, "Should not anchor to the file-level directive");
  });

  test('file-level "use no memo" marks in-source use memo as skipped and hides virtual lenses', () => {
    const text = `'use no memo';

${readFixture("annotation-mode.tsx")}`;
    const document = TextDocument.create("file:///mock/file-no-memo-annotation.tsx", "typescriptreact", 1, text);
    const { successfulCompilations, failedCompilations, skippedCompilations } = compileFixture(
      text,
      "/mock/file-no-memo-annotation.tsx",
      "react-compiler-annotation.cjs"
    );

    assert.ok(successfulCompilations.length > 0, "Compiler still logs CompileSuccess for validation");
    const markers = generateMarkers(
      document,
      successfulCompilations,
      failedCompilations,
      skippedCompilations
    );
    assert.strictEqual(markers.filter((marker: CompilerMarker) => marker.virtual).length, 0);
    const skipped = markers.filter((marker: CompilerMarker) => marker.kind === "skipped");
    assert.ok(skipped.length >= 1, "Expected skipped marker on opted-in directive");
    assert.ok(markerCoversUseMemo(document, skipped[0]));
    assert.ok(skipped[0].skipReason?.includes("use no memo"));
  });

  test('function-level "use no memo" marks directive as skipped using compiler CompileSkip reason', () => {
    const text = readFixture("use-no-memo.tsx");
    const document = TextDocument.create("file:///mock/use-no-memo.tsx", "typescriptreact", 1, text);
    const { skippedCompilations, successfulCompilations, failedCompilations } = compileFixture(
      text,
      "/mock/use-no-memo.tsx"
    );

    assert.strictEqual(skippedCompilations.length, 1);
    const markers = generateMarkers(
      document,
      successfulCompilations,
      failedCompilations,
      skippedCompilations
    );
    const skipped = markers.filter((marker: CompilerMarker) => marker.kind === "skipped");
    assert.ok(skipped.length >= 1);
    assert.ok(
      skipped[0].skipReason?.toLowerCase().includes("use no memo"),
      `Expected skip reason to mention use no memo, got: ${skipped[0].skipReason}`
    );
    assert.ok(markerCoversUseNoMemo(document, skipped[0]));
  });

  test('in-body "use no memo" on a failed compile marks the directive as skipped', () => {
    const text = `import React from "react";

export function Broken() {
  "use no memo";
  const ref = React.useRef(0);
  ref.current = 1;
  return <div>{ref.current}</div>;
}`;
    const document = TextDocument.create("file:///mock/failed-no-memo.tsx", "typescriptreact", 1, text);
    const { successfulCompilations, failedCompilations } = compileFixture(
      text,
      "/mock/failed-no-memo.tsx"
    );

    assert.ok(failedCompilations.length > 0, "Expected compile errors for Broken");

    const markers = generateMarkers(document, successfulCompilations, failedCompilations);
    const skipped = markers.filter((marker: CompilerMarker) => marker.kind === "skipped");
    assert.ok(skipped.length >= 1);
    assert.ok(markerCoversUseNoMemo(document, skipped[0]));
    assert.strictEqual(markers.filter((marker: CompilerMarker) => marker.virtual).length, 0);
  });

  test('"use no memo" components are skipped by the compiler and get no markers', () => {
    const text = readFixture("use-no-memo.tsx");
    const document = TextDocument.create("file:///mock/use-no-memo.tsx", "typescriptreact", 1, text);
    const { skippedCompilations, successfulCompilations, failedCompilations } = compileFixture(
      text,
      "/mock/use-no-memo.tsx"
    );

    assert.strictEqual(
      skippedCompilations.length,
      1,
      `Expected 1 skipped compilation, got ${skippedCompilations.length}`
    );
    const optedOut = skippedCompilations[0];

    const markers = generateMarkers(document, successfulCompilations, failedCompilations);
    assert.ok(markers.length > 0, "Other components in the file should still be marked");

    const skipStart = (optedOut.fnLoc?.start?.line ?? 1) - 1;
    const skipEnd = (optedOut.fnLoc?.end?.line ?? skipStart + 1) - 1;
    for (const marker of markers) {
      const markerLine = marker.virtual ? (marker.codeLensLine ?? marker.startLine) : marker.startLine;
      const overlaps = markerLine >= skipStart && markerLine <= skipEnd;
      assert.ok(!overlaps, "Opted-out component should not have a marker");
    }
  });
});
