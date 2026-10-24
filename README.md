# Bash Language Server

Bash language server that brings an IDE-like experience for bash scripts to most editors. This is based on the [Tree Sitter parser][tree-sitter-bash] and supports [explainshell][explainshell], [shellcheck][shellcheck] and [shfmt][shfmt].

Documentation around configuration variables can be found in the [config.ts](https://github.com/bash-lsp/bash-language-server/blob/main/server/src/config.ts) file.

## Features

- Jump to declaration
- Find references
- Code Outline & Show Symbols
- Highlight occurrences
- Code completion
- Simple diagnostics reporting
- ShellCheck quick fixes and actions to disable a rule for a command or the entire file
- Documentation for symbols on hover
- Workspace symbols
- Rename symbol
- Format document
- **Flow-sensitive variable resolution** — resolve variable values through control flow (arithmetic, parameter expansion, constant `if`/`case` branch evaluation), displayed as inlay hints
- **Branch dimming** — dims untaken `if`/`else`/`elif` and `case` branches when the condition evaluates to a constant
- **Dynamic source resolution** — resolve `source`/`.` paths using flow-resolved variables, with ShellCheck directives (`source=`, `source-fallback=`, `source-path=`) and `# bash-ide` directives
- **Path completions** inside `shellcheck source=` and `source-fallback=` comment directives

To be implemented:

- Better jump to declaration and find references based on scope
- Full interprocedural flow analysis (function call resolution)

## Installation

### Dependencies

As a dependency, we recommend that you first install [shellcheck][shellcheck] to enable linting:
https://github.com/koalaman/shellcheck#installing . If `shellcheck` is installed,
bash-language-server will automatically call it to provide linting and code analysis each time the
file is updated (with debounce time of 500ms).

ShellCheck diagnostics offer quick fixes to insert `# shellcheck disable=SCxxxx`
directives. Command-level suppression covers the containing shell command, including
multiline commands and pipelines. It is offered only when a directive can be placed
at a valid command boundary. Before the first top-level command, ShellCheck applies
directives to the entire file, so only the file-level suppression is offered there.

If you want your shell scripts to be formatted consistently, you can install [shfmt][shfmt]. If
`shfmt` is installed then your documents will be formatted whenever you take the 'format document'
action. In most editors this can be configured to happen automatically when files are saved.

### Bash language server

Usually you want to install a client for your editor (see the section below).

But if you want to install the server binary (for examples for editors, like helix, where a generic LSP client is built in), you can install from npm registry as:

```bash
npm i -g bash-language-server
```

Alternatively, bash-language-server may also be distributed directly by your Linux distro, for example on Fedora based distros:

```bash
dnf install -y nodejs-bash-language-server
```

Or on Ubuntu with snap:

```bash
sudo snap install bash-language-server --classic
```

To verify that everything is working:

```bash
bash-language-server --help
```

If you encounter installation errors, ensure you have node version 20 or newer (`node --version`).

### Clients

The following editors and IDEs have available clients:

- Atom ([ide-bash][ide-bash])
- Eclipse ([ShellWax](https://marketplace.eclipse.org/content/shellwax))
- Emacs ([see below](#emacs))
- [Helix](https://helix-editor.com/) (built-in support)
- JupyterLab ([jupyterlab-lsp][jupyterlab-lsp])
- Neovim ([see below](#neovim))
- Sublime Text ([LSP-bash][sublime-text-lsp])
- Vim ([see below](#vim))
- Visual Studio Code ([Bash IDE][vscode-marketplace])
- [Oni](https://github.com/onivim/oni) ([see below](#oni))

#### Vim

For Vim 8 or later install the plugin [prabirshrestha/vim-lsp][vim-lsp] and add the following configuration to `.vimrc`:

```vim
if executable('bash-language-server')
  au User lsp_setup call lsp#register_server({
        \ 'name': 'bash-language-server',
        \ 'cmd': {server_info->['bash-language-server', 'start']},
        \ 'allowlist': ['sh', 'bash'],
        \ })
endif
```

For Vim 8 or Neovim using [YouCompleteMe](https://github.com/ycm-core/YouCompleteMe), add the following to `.vimrc`:

```vim
let g:ycm_language_server =
            \ [
            \   {
            \       'name': 'bash',
            \       'cmdline': [ 'bash-language-server', 'start' ],
            \       'filetypes': [ 'sh' ],
            \   }
            \ ]
```

For Vim 8 or Neovim using [neoclide/coc.nvim][coc.nvim], according to [it's Wiki article](https://github.com/neoclide/coc.nvim/wiki/Language-servers#bash), add the following to your `coc-settings.json`:

```jsonc
  "languageserver": {
    "bash": {
      "command": "bash-language-server",
      "args": ["start"],
      "filetypes": ["sh"],
      "ignoredRootPaths": ["~"]
    }
  }
```

For Vim 8 or NeoVim using [dense-analysis/ale][vim-ale] add the following
configuration to your `.vimrc`:

```vim
let g:ale_linters = {
    \ 'sh': ['language_server'],
    \ }
```

For Vim8/NeoVim v0.5 using [jayli/vim-easycomplete](https://github.com/jayli/vim-easycomplete). Execute `:InstallLspServer sh` and config nothing. Maybe it's the easiest way to use bash-language-server in vim/nvim.

#### Neovim

For Neovim 0.11+ with [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig)

```lua
vim.lsp.enable 'bashls'
```
For Neovim 0.11+ without plugins

```lua
vim.lsp.config.bashls = {
  cmd = { 'bash-language-server', 'start' },
  filetypes = { 'bash', 'sh' }
}
vim.lsp.enable 'bashls'
```

For Neovim 0.10 or lower with [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig)
```lua
require 'lspconfig'.bashls.setup {}
```

#### Oni

On the config file (`File -> Preferences -> Edit Oni config`) add the following configuration:

```javascript
"language.bash.languageServer.command": "bash-language-server",
"language.bash.languageServer.arguments": ["start"],
```

#### Emacs

[Lsp-mode](https://github.com/emacs-lsp/lsp-mode) has a built-in client, can be installed by `use-package`.
Add the configuration to your `.emacs.d/init.el`

```emacs-lisp
(use-package lsp-mode
  :commands lsp
  :hook
  (sh-mode . lsp))
```

Using the built-in `eglot` lsp mode:

```emacs-lisp
(use-package eglot
  :config
  (add-to-list 'eglot-server-programs '((sh-mode bash-ts-mode) . ("bash-language-server" "start")))

  :hook
  (sh-mode . eglot-ensure)
  (bash-ts-mode . eglot-ensure))
```

## Background analysis limits

Background discovery stops after `backgroundAnalysisMaxFiles` matches (default 500),
or 10,000 directory reads. The whole background pass has a built-in 10-second
budget covering discovery, file reads, and checks between parses. A synchronous
parse already in progress finishes before the server can stop the pass. A warning
in Bash IDE's output reports when a limit is reached; workspace symbols may then
be incomplete. Opening a file or following a source command still allows that
file to be analyzed.

With the default `globPattern`, discovery skips hidden files and directories
before traversing them. Custom glob patterns can still target hidden directories.

`backgroundAnalysisIgnore` is an array of glob patterns, defaulting to
`["**/node_modules/**", "**/.git/**"]`. Add patterns such as `"**/build/**"` to skip
large generated directories. These exclusions do not read `.gitignore`.
Set `backgroundAnalysisMaxFiles` to `0` to disable background discovery entirely.
In VS Code, prefix each setting with `bashIde.`. Configuration changes cancel the
previous scan. Its background-only cache entries are removed when absent from the
replacement scan, including when newly ignored; opened documents and their sourced
dependencies remain available. Server shutdown stops pending background work.

## `shfmt` integration

The indentation used by `shfmt` is whatever has been configured for the current editor session, so
there is no `shfmt`-specific configuration variable for this. If your editor is configured for
two-space indents then that's what it will use. If you're using tabs for indentation then `shfmt`
will use that.

The `shfmt` integration also supports configuration via `.editorconfig`. If any `shfmt`-specific
configuration properties are found in `.editorconfig` then the config in `.editorconfig` will be
used and the language server config will be ignored. This follows `shfmt`'s approach of using either
`.editorconfig` or command line flags, but not both. Note that only `shfmt`-specific configuration
properties are read from `.editorconfig` - indentation preferences are still provided by the editor,
so to format using the indentation specified in `.editorconfig` make sure your editor is also
configured to read `.editorconfig`. It is possible to disable `.editorconfig` support and always use
the language server config by setting the "Ignore Editorconfig" configuration variable.

## Flow Analysis

When enabled via `bashIde.enableFlowAnalysis: true`, the server runs a flow-sensitive analysis
engine that resolves variable values through control flow. Results are shown as **inlay hints**
after assignments, and untaken `if`/`else`/`case` branches are **dimmed** (shown as hint-level
diagnostics).

### What Gets Resolved

- **Arithmetic expressions**: `$((x + 1))` and `((x++))` are evaluated when operand values are known
- **Parameter expansion**: `${VAR:-default}`, `${VAR:=assign}`, and the `: "${VAR:=default}"` pattern are resolved
- **Constant branch evaluation**: `if [[ $KNOWN -eq 1 ]]`, `case $VERSION in ...`, and `while`/`until` conditions are evaluated when values are known
- **Live PWD tracking**: `cd`, `pushd`, and `popd` commands update the working directory for relative path resolution
- **Dynamic source resolution**: `source` and `.` commands resolve paths using flow-resolved variables
- **Narrowing**: inside `if "$flag"`, `[[ -n $x ]] && ...` or `case $x in a)` branches, and after them, a variable with a few known values holds only the values that reach that point
- **Path termination**: paths that reach `exit` or `return` (including `[[ -n $x ]] || exit`), and failing `[[ ... ]]`, `test` or `false` statements under `set -e`, do not contribute values to the code after them

### BashTab Scripts

With `bashIde.enableBashTabAnalysis: true`, flow analysis also models the argument parser of
[BashTab](https://github.com/sunjc826/BashTab) commands. In an option's `case` arm,
`bu_parse_positional $# SPEC...` followed by `bu_validate_positional` makes `${!shift_by}` hold one of
the values the spec lists with `:value` or `--enum ... enum--`:

```bash
--vm)# GUEST
    bu_parse_positional $# :linux :mac
    bu_validate_positional "${!shift_by}"
    vm=${!shift_by}   # → linux or mac
    ;;
```

Specs that generate values at completion time (`--stdout`, `--glob`, `-c`, file specs) leave the value
unknown. `bu_parse_error_enum` and `bu_parse_error_argn` set `is_help=true`, `bu_assert_err` stops
the path under `set -e`, and calling a function makes `BU_RET` and `BU_RET_MAP` unknown, since BashTab
functions return their results there.

### `# bash-ide` Directives

Place these comments in your shell scripts to control flow analysis behavior:

```bash
# Set the working directory for relative path resolution and source commands
# bash-ide cwd=/path/to/project

# Run a setup command before analysis (its variable assignments and exports are injected)
# bash-ide env-init=source /opt/sdk/env.sh

# Multi-line env-init block
# bash-ide env-init-begin
source /opt/sdk/env.sh
export CUSTOM_VAR="hello"
# bash-ide env-init-end

# Auto-set PWD to a sourced file's own directory, so relative references inside it resolve
# bash-ide source-pushd
source ./lib/helpers.sh
```

### ShellCheck Source Directives

For source commands whose path can't be statically determined, ShellCheck directives provide
explicit or fallback paths. **Path completions** are offered inside `source=` and `source-fallback=`
values:

```bash
# shellcheck source=/explicit/path/to/file.sh
source "$DYNAMIC_PATH"

# shellcheck source-fallback=/fallback/path.sh  (used when dynamic resolution fails)
source "$MAYBE_UNDEFINED"

# shellcheck source-path=my_scripts  (search root for resolving relative paths)
source "my_helper.sh"

# shellcheck source=/dev/null  (suppress the error entirely)
source "$UNKNOWN"
```

### Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bashIde.enableFlowAnalysis` | `boolean` | `false` | Enable flow-sensitive analysis, inlay hints, branch dimming, and dynamic source resolution |
| `bashIde.enableBashTabAnalysis` | `boolean` | `false` | Model [BashTab](#bashtab-scripts) argument parsing in flow analysis |
| `bashIde.seedVariables` | `object` | `{}` | Pre-seeded `{ VAR: value }` map for variables not in the server environment but needed for path resolution |
| `bashIde.pathEnvInit` | `array` | `[]` | Path-based env init rules (see below) |

#### `pathEnvInit` Rules

An array of rules triggered when a file path matches a glob pattern. Relative patterns are matched
against the path relative to the workspace folder. `*` and `?` match within one path segment, `**`
matches any number of segments, and `(*)` captures one segment, referenced as `$1`, `$2`, etc. in
`variables` and `envInit`. Rules apply in order, and their `envInit` commands run before the
file's own `# bash-ide env-init` directives:

```jsonc
{
  "bashIde.pathEnvInit": [
    {
      // Glob pattern with (*) capture groups
      "path": "projects/(*)/scripts/(*).sh",
      // Variables seeded with captured values ($1, $2, etc. are capture groups)
      "variables": { "PROJECT": "$1", "SCRIPT_NAME": "$2" },
      // Command run before analysis (supports $1/$2 expansion)
      "envInit": "source /opt/$1/env.sh",
      // Auto-set PWD to sourced file directories
      "sourcePushd": true
    },
    {
      // sourcePushd-only rules apply additively
      "path": "libs/(*)/**/*.sh",
      "sourcePushd": true
    }
  ]
}
```

## Logging

The minimum logging level for the server can be adjusted using the `BASH_IDE_LOG_LEVEL` environment variable
and through the general [workspace configuration](https://github.com/bash-lsp/bash-language-server/blob/main/server/src/config.ts).

## Development Guide

Please see [docs/development-guide][dev-guide] for more information.

[tree-sitter]: https://github.com/tree-sitter/tree-sitter
[tree-sitter-bash]: https://github.com/tree-sitter/tree-sitter-bash
[vscode-marketplace]: https://marketplace.visualstudio.com/items?itemName=mads-hartmann.bash-ide-vscode
[dev-guide]: https://github.com/bash-lsp/bash-language-server/blob/master/docs/development-guide.md
[ide-bash]: https://atom.io/packages/ide-bash
[sublime-text-lsp]: https://packagecontrol.io/packages/LSP-bash
[explainshell]: https://explainshell.com/
[shellcheck]: https://www.shellcheck.net/
[shfmt]: https://github.com/mvdan/sh#shfmt
[languageclient-neovim]: https://github.com/autozimu/LanguageClient-neovim
[nvim-lspconfig]: https://github.com/neovim/nvim-lspconfig
[vim-lsp]: https://github.com/prabirshrestha/vim-lsp
[vim-ale]: https://github.com/dense-analysis/ale
[coc.nvim]: https://github.com/neoclide/coc.nvim
[jupyterlab-lsp]: https://github.com/krassowski/jupyterlab-lsp
