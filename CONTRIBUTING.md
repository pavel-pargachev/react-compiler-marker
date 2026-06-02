# Contributing to React Compiler Marker

## Fork context

Personal **VS Code–only fork** of [blazejkustra/react-compiler-marker](https://github.com/blazejkustra/react-compiler-marker) by Blazej Kustra. IntelliJ, Neovim, and Zed clients were removed on purpose. **Not maintained for upstream contribution** — optimize for this fork, not for restoring deleted IDE clients or matching the origin repo.

## Prerequisites

- Node.js 20+
- npm 9+

## Getting Started

```bash
# Clone the repository
git clone https://github.com/pavel-pargachev/react-compiler-marker.git
cd react-compiler-marker

# Install dependencies
npm install
```

## Project Structure

```
packages/
  server/           # LSP server (TypeScript)
  vscode-client/    # VS Code extension (TypeScript)
```

### Server

The LSP server powers the VS Code extension. It handles React Compiler analysis and provides language server protocol support.

```bash
cd packages/server
npm run build
npm run watch
```

### VS Code Client

```bash
cd packages/vscode-client

# Build extension
npm run compile

# Watch mode
npm run watch

# Run tests
npm run test

# Package for distribution
npm run package

# Create a VSIX for local install
npx vsce package
```

To debug the extension:

1. Open the project in VS Code
2. Press F5 to launch Extension Development Host

## Code Style

- TypeScript: ESLint + Prettier (run `npm run prettier` from root)

## Testing

```bash
# From root - shared checks
npm run typecheck
npm run lint
npm run prettier

# From packages/vscode-client - extension tests
cd packages/vscode-client
npm run test
```

## Versioning

| Package | Version Location |
|---------|------------------|
| VS Code Client | `packages/vscode-client/package.json` |
| Server | `packages/server/package.json` |

## Local VSIX build

```bash
cd packages/vscode-client
npm version <version> --no-git-tag-version
npx vsce package
```

Install the resulting `.vsix` via **Extensions → Install from VSIX...** in VS Code.

## Questions?

Open an issue on [GitHub](https://github.com/pavel-pargachev/react-compiler-marker/issues).
