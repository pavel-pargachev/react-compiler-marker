import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.join(__dirname, "..", "..", "test", "fixtures");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkReactCompiler } = require(path.join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "out",
  "checkReactCompiler"
));

export function readFixture(name: string): string {
  const fixturePath = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${name}`);
  }
  return fs.readFileSync(fixturePath, "utf8");
}

export function getFixturesDir(): string {
  if (!fs.existsSync(FIXTURES_DIR)) {
    throw new Error(`Fixtures directory not found: ${FIXTURES_DIR}`);
  }
  return FIXTURES_DIR;
}

export function getRepoRoot(): string {
  return path.join(__dirname, "..", "..", "..", "..");
}

export function compileFixture(
  text: string,
  filename: string,
  configFixture = "react-compiler-all-paths.cjs"
) {
  const repoRoot = getRepoRoot();
  const relativeConfigFile = path
    .relative(repoRoot, path.join(getFixturesDir(), configFixture))
    .replace(/\\/g, "/");

  return checkReactCompiler(
    text,
    filename,
    repoRoot,
    "node_modules/babel-plugin-react-compiler",
    relativeConfigFile
  );
}
