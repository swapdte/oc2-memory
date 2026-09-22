# Repository Guidelines

## Project Structure & Module Organization

- `index.ts`: the entire pi extension (single-file, TypeScript loaded directly by `pi`)
- `test/e2e.ts`: end-to-end tests that invoke `pi` as a subprocess
- `README.md`: user-facing install/usage docs
- `package.json`: metadata + **peer** dependencies (provided by the pi runtime)

Runtime data lives outside the repo under `~/.pi/agent/memory/` (`MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`).

## Activity Tracking (Required)

- Track all work sessions by writing a short entry to the pi-memory daily log using `memory_write` (target: `daily`).
- Summaries should include what changed, files touched, and any notable decisions.
- Use the scratchpad tool for follow-ups or TODOs discovered during work.

## Build, Test, and Development Commands

- `pi -p -e ./index.ts "remember: I prefer dark mode"`: manual local run (print mode)
- `pi install .` (or from the parent folder: `pi install ./pi-memory`): install the extension into pi
- `npm test`: run the fast unit suite (`bun test test/unit.test.ts`; no API key, no qmd)
- `npm run test:e2e` (or `npx tsx test/e2e.ts`): run E2E tests (requires `pi` on PATH + a configured API key)
- `npm run test:eval`: run the recall-effectiveness eval (requires `pi` + API key + qmd)
- `npm run build`: typecheck with `tsc` (`--noEmit`)
- `npm run lint`: lint with Biome
- Optional (for `memory_search`, requires Bun): `command -v qmd >/dev/null 2>&1 || bun install -g https://github.com/tobi/qmd`
- Optional search setup: `qmd collection add ~/.pi/agent/memory --name pi-memory && qmd embed`

## Coding Style & Naming Conventions

- Keep `index.ts` self-contained; avoid adding a build step unless absolutely necessary.
- Match existing formatting: tabs for indentation, semicolons, and double quotes.
- Naming: `camelCase` for functions, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants; tool names remain `snake_case` (e.g. `memory_write`).

## Testing Guidelines

- Enforce TDD for every behavior change: follow `red -> green -> refactor`.
- Start by establishing a verifiable baseline: run the relevant existing tests before edits, and record the exact command + outcome in the PR/commit notes.
- Add or update a failing test first that reproduces the bug or captures the new requirement; implement code only after the test fails for the expected reason.
- Keep tests green after implementation and after any refactor; do not merge with skipped failing tests.
- Every bug fix must include a regression test that fails before the fix and passes after it.
- Tests touch `~/.pi/agent/memory/`; ensure backups/restores remain intact and new tests don’t leak user data.
- Prefer behavior-focused assertions (tool availability, file contents, cross-session recall). Keep timeouts generous for model latency.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) and keep messages imperative.
- PRs: include a short summary, exact test command(s) run, and call out any changes to on-disk memory formats or `qmd` behavior.

## Security & Configuration Tips

- Never commit real memory files or secrets. Tests assume `pi` is configured via environment (e.g. `OPENAI_API_KEY`).

## Tooling Rules

### 1. File discovery — use the `fff` MCP tools

Use the `fff` MCP tools for all file discovery and file search operations instead of shell commands or the default tools:

- `find_files` — find files by name, glob, or path prefix → **replaces `ls`, `find`, and `tree`**.
- `grep` — search file contents for an identifier → replaces `grep` / `rg`.
- `multi_grep` — OR-search several identifiers in one call.

Do not use `ls` or `find` to list or explore the filesystem; use `find_files` instead. Only fall back to a shell command when `fff` cannot express the operation.

### 2. Library & API knowledge — `context7` first, then `deepwiki`

When the behavior, API, configuration, or usage of a library, framework, SDK, or CLI tool is unclear, do not guess — look it up. Use the MCP documentation servers in this order:

1. **`context7` MCP** — resolve the library with `resolve-library-id`, then query it with `query-docs`. Preferred for concrete API syntax, setup/configuration, version-specific behavior, and current official examples.
2. **`deepwiki` MCP** — if `context7` has no coverage, or the question is about a GitHub repository's architecture, internals, or design rationale, use `read_wiki_structure` / `read_wiki_contents`.

Fall back to prior knowledge only when both sources are exhausted or the API is trivial and stable.

### 3. Shell commands — always use `rtk`

`rtk` is a token-optimized CLI proxy that filters and summarizes command output before it reaches the model context (up to ~90% fewer output tokens).

> **Status:** rtk's automatic hook/plugin integration does **not** support OpenCode v2 yet. Until it does, the rules in this file are the mechanism — apply the `rtk` prefix manually on every command.

**Rule:** whenever `rtk` is installed, run shell commands through its subcommands instead of the native binaries — for example `rtk git status` instead of `git status`.

> Exception: for listing and locating files, the `fff` tools from section 1 take precedence over `rtk ls` / `rtk find`. Use the `rtk` wrappers for everything else and whenever a shell command is genuinely required.

**Availability check (once per session):**

```bash
rtk --version 2>/dev/null || echo "rtk unavailable"
```

- Prints `rtk <version>` → `rtk` is available: use the `rtk` form for every command in the mapping below.
- `command not found` or non-zero exit → fall back to the native commands for the rest of the session. Do not retry `rtk` on every call.

#### Command mapping

| Native                                  | Use instead            |
| --------------------------------------- | ---------------------- |
| `ls` *(prefer `fff find_files`)*        | `rtk ls`               |
| `tree` *(prefer `fff find_files`)*      | `rtk tree`             |
| `cat`, `head`, `tail`                   | `rtk read <file>`      |
| `grep`                                  | `rtk grep <pattern>`   |
| `rg`                                    | `rtk rg <pattern>`     |
| `find` *(prefer `fff find_files`)*      | `rtk find`             |
| `wc`                                    | `rtk wc`               |
| `git …`                                 | `rtk git …`            |
| `gh …`                                  | `rtk gh …`             |
| `glab …`                                | `rtk glab …`           |
| `docker …`                              | `rtk docker …`         |
| `kubectl …`                             | `rtk kubectl …`        |
| `npm …`                                 | `rtk npm …`            |
| `npx …`                                 | `rtk npx …`            |
| `pnpm …`                                | `rtk pnpm …`           |
| `cargo …`                               | `rtk cargo …`          |
| `tsc`                                   | `rtk tsc`              |
| `eslint` / `lint`                       | `rtk lint`             |
| `prettier`                              | `rtk prettier`         |
| `jest`                                  | `rtk jest`             |
| `vitest`                                | `rtk vitest`           |
| `playwright`                            | `rtk playwright`       |
| `next build`                            | `rtk next`             |
| `prisma …`                              | `rtk prisma …`         |
| `curl …`                                | `rtk curl …`           |
| `wget …`                                | `rtk wget …`           |
| `aws …`                                 | `rtk aws …`            |
| `psql …`                                | `rtk psql …`           |
| `dotnet …`                              | `rtk dotnet …`         |
| any test runner (e.g. `cargo test`)     | `rtk test <cmd>`       |
| any command, errors/warnings only       | `rtk err <cmd>`        |
| any command, heuristic summary          | `rtk summary <cmd>`    |
| any command, unfiltered                 | `rtk proxy <cmd>`      |

#### Notes

- `rtk` subcommands pass native flags through: `rtk ls -la`, `rtk grep -i -A 3 "foo" src/`, `rtk git diff --staged` all work.
- For listing files or building a tree, prefer `fff find_files` (section 1). `rtk ls`, `rtk tree`, and `rtk find` are the shell fallback and proxy the native tools.
- Meta/analytics commands are always called directly on `rtk`: `rtk gain`, `rtk gain --history`, `rtk discover`, `rtk config`.
- If `rtk` filtering hides information you need (e.g. exact file contents with line numbers), re-run with the native command or `rtk read --level none -n`.
- Do not wrap commands that `rtk` does not support. If no rtk subcommand exists, run the native command directly.
- Do **not** rely on `rtk init --opencode`: the OpenCode hook/plugin is not supported on OpenCode v2 yet. Once support lands, the automatic rewrite can replace the manual prefixing described here.

⚠️ **Name collision:** if `rtk gain` fails, a different `rtk` (reachingforthejack/rtk, "Rust Type Kit") may be on `PATH`. Verify with `which rtk`; if it is the wrong binary, fall back to the native commands.
