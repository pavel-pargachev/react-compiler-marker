import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  clearReactCompilerConfigCache,
  getReactCompilerFileContext,
} = require(path.join(__dirname, "..", "..", "..", "server", "out", "reactCompilerConfig"));

function withTempWorkspace(run: (workspaceDir: string, configFile: string) => void): void {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcm-config-"));
  const configFile = "react-compiler-config.cjs";
  fs.writeFileSync(path.join(workspaceDir, "package.json"), "{}");
  clearReactCompilerConfigCache();
  try {
    run(workspaceDir, configFile);
  } finally {
    clearReactCompilerConfigCache();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

suite("reactCompilerConfig reload", () => {
  test("reloads config when the file changes without restarting the server", () => {
    withTempWorkspace((workspaceDir, configFile) => {
      const sampleFile = path.join(workspaceDir, "src", "App.tsx").replace(/\\/g, "/");

      const writeConfig = (paths: string[]) => {
        const contents = `module.exports = { reactCompilerPaths: ${JSON.stringify(paths)} };`;
        fs.writeFileSync(path.join(workspaceDir, configFile), contents);
      };

      const inPathsForSample = () => {
        const context = getReactCompilerFileContext(sampleFile, workspaceDir, configFile);
        return context?.inReactCompilerPaths ?? false;
      };

      writeConfig(["src"]);
      assert.strictEqual(inPathsForSample(), true);

      writeConfig(["lib"]);
      clearReactCompilerConfigCache();
      assert.strictEqual(inPathsForSample(), false);
    });
  });

  test("reloads .ts config from disk without require cache", () => {
    withTempWorkspace((workspaceDir, configFile) => {
      const tsConfigFile = "react-compiler-config.ts";
      const sampleFile = path.join(workspaceDir, "src", "App.tsx").replace(/\\/g, "/");

      const writeConfig = (paths: string[]) => {
        const contents = `export const reactCompilerPaths = ${JSON.stringify(paths)};`;
        fs.writeFileSync(path.join(workspaceDir, tsConfigFile), contents);
      };

      const inPathsForSample = () => {
        const context = getReactCompilerFileContext(sampleFile, workspaceDir, tsConfigFile);
        return context?.inReactCompilerPaths ?? false;
      };

      writeConfig(["src"]);
      assert.strictEqual(inPathsForSample(), true);

      writeConfig(["lib"]);
      assert.strictEqual(inPathsForSample(), false);
    });
  });

  test("reloads config when mtime changes without clearing the in-memory cache", () => {
    withTempWorkspace((workspaceDir, configFile) => {
      const sampleFile = path.join(workspaceDir, "src", "App.tsx").replace(/\\/g, "/");

      const writeConfig = (paths: string[]) => {
        const contents = `module.exports = { reactCompilerPaths: ${JSON.stringify(paths)} };`;
        fs.writeFileSync(path.join(workspaceDir, configFile), contents);
      };

      const inPathsForSample = () => {
        const context = getReactCompilerFileContext(sampleFile, workspaceDir, configFile);
        return context?.inReactCompilerPaths ?? false;
      };

      writeConfig(["src"]);
      assert.strictEqual(inPathsForSample(), true);

      writeConfig(["lib"]);
      assert.strictEqual(inPathsForSample(), false);
    });
  });
});
