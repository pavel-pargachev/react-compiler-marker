# React Compiler Marker

Personal fork of the original [blazejkustra/react-compiler-marker](https://github.com/blazejkustra/react-compiler-marker) by Blazej Kustra.

**VS Code extension that shows which React components are optimized by the [React Compiler](https://react.dev/learn/react-compiler)**.
## Features

- `'use memo';` Code Lens
- React Compiler error reporting
- Preview compiled output to see what the React Compiler generates
- Configurable babel plugin path for custom setups

## Installation

Build and install the extension locally as a VSIX:

```bash
cd packages/vscode-client
npx vsce package
```

In VS Code: Extensions view → `...` menu → **Install from VSIX...** → select `react-compiler-marker-*.vsix`.

Extension ID: `pavel-pargachev.react-compiler-marker`

## Project Structure

```
packages/
  server/           # LSP server (used by the VS Code extension)
  vscode-client/    # VS Code extension
```

See [packages/vscode-client/README.md](packages/vscode-client/README.md) for extension-specific documentation.

## Quick Start

1. Install the extension from a locally built VSIX (see [Installation](#installation))
2. Open a React component file — markers appear automatically

## Links

- [GitHub Repository](https://github.com/pavel-pargachev/react-compiler-marker)
- [React Compiler Documentation](https://react.dev/learn/react-compiler)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT
