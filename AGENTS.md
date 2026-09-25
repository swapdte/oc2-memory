# AGENTS.md

An **OpenCode V2 plugin** that gives the coding agent a memory: durable facts, a daily log, and a
scratchpad, all as plain markdown, with optional qmd-powered search. It is a port of
[pi-memory](https://github.com/jayzeng/pi-memory) — a pi extension — onto OpenCode's V2 plugin SDK,
`@opencode/plugin`.

**Port status: released.** `oc2-memory@0.1.1` is on npm. `index.ts` is a pure V2 plugin — the seven
tools with JSON-Schema inputs, the byte-stable snapshot, and the compaction handoff — with **no**
`@earendil-works/pi-*` dependency; `bin/cli.ts` provides `npx oc2-memory install|uninstall|status`.
See `PLAN.md` and `DECISIONS.md` for the phase plan and the decisions behind the port.

- `origin` → `swapdte/oc2-memory` (this project)
- `upstream` → `jayzeng/pi-memory` (read-only source, for selective cherry-picks)
- Author: swapdte · License: MIT — `LICENSE` carries both Jay Zeng (upstream) and Marc Kerkmann

## Working docs

`DECISIONS.md` and `PLAN.md` are **committed** and written in **German** — the language they were
drafted in — while the rest of the repository is English. `DECISIONS.md` records every settled
technical decision; `PLAN.md` holds the phase plan and its gates. Read `DECISIONS.md` before making
a design call and `PLAN.md` before starting a phase. Where this file and those two disagree about the
port's target behaviour, they win.

## Layout

- `index.ts` — the entire plugin in one source file. It is **built**, not loaded raw: OpenCode
  resolves a plugin's entrypoints as module paths, so `tsup` bundles it to `dist/index.js`, which is
  what `main` and `exports` point at. One source file, one artefact.
- `bin/cli.ts` — the `npx oc2-memory` installer (install/uninstall/status). A `bin` needs its own JS
  entry file, so it is a **second** source file and a second `tsup` output (`dist/cli.js`). It runs
  under **Node**, so: no Bun APIs. It reuses `index.ts` helpers (path resolution, qmd) as the single
  source of truth.
- `test/` — `unit.test.ts` (fast, deterministic, no network), `e2e.ts` (spawns a real agent),
  `eval-recall.ts` (recall A/B), `qmd-cache.ts`
- `design.md` — upstream's rationale. Still the best account of *why* the design is what it is,
  even where the naming says pi.
- `CHANGELOG.md` — upstream history, kept for attribution
- `.githooks/`, `scripts/postinstall.cjs` — dev-only commit hooks
- `.github/workflows/` — CI (lint, build, unit tests, publish) plus the Windows qmd smoke test; all
  run against the V2 plugin

Memory files live outside the repo — `~/.pi/agent/memory/`, falling back to `~/.oc2-memory/`.

## Commands

| Purpose | Command |
| --- | --- |
| Unit tests — no API key, no qmd | `npm test` |
| Build to `dist/`, then typecheck | `npm run build` |
| Lint and format | `npm run lint` |
| End-to-end — real agent, needs an API key | `npm run test:e2e` |
| Recall eval — agent + API key + qmd | `npm run test:eval` |

Node ≥ 22 and Bun are required. Run `npm install` once after cloning: it is what points git at
`.githooks`, so commits are unchecked until you do.

## Workflow

TDD on every change: write the failing test first, watch it fail **for the reason you expect**, then
implement. A bug fix ships with a regression test that fails before it and passes after. Run the
baseline before you start and leave the tree green after every step.

Unit tests use per-test temp directories and never touch the real memory store; `npm run test:e2e`
uses the active memory directory. Back it up and restore it; never leave a test's data behind.

## Conventions

- `biome.json` is the source of truth for formatting — run `npm run lint`.
- `camelCase` functions, `PascalCase` types, `SCREAMING_SNAKE_CASE` constants. Tool names stay
  `snake_case` (`memory_write`), because they are the public API.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`), imperative. No DCO sign-off.
- Keep `index.ts` self-contained — one source file, one built artefact. `tsup` is the only build
  step, and it exists because OpenCode loads a plugin by module path; prefer editing `index.ts` over
  adding source files or more tooling. **One exception:** `bin/cli.ts` is a second source file and a
  second `tsup` entry (`build:plugin` + `build:cli`), because a `bin` requires its own JS entry.
  Keep the two builds separate so `dist/index.js` stays a standalone plugin bundle with no shared
  chunk.
- `@opencode/plugin@2.0.2` is a **devDependency** (used for types only). The plugin has no runtime
  dependencies, and there are no `@earendil-works/pi-*` packages left.

## Activity tracking

Log every work session to the daily memory log with `memory_write` (`target: "daily"`): what changed,
which files, which decisions. Use the scratchpad for follow-ups the session uncovers. The project
dogfoods its own plugin — `memory_status` reports where the log actually lives.

## Tooling

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

> Exception: for file discovery and content search, the `fff` tools from section 1 always take precedence over `rtk ls` / `rtk find` / `rtk grep` / `rtk rg`. Use the `rtk` wrappers for everything else and whenever a shell command is genuinely required.

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
| `grep` *(prefer `fff grep`)*            | `rtk grep <pattern>`   |
| `rg` *(prefer `fff grep`)*              | `rtk rg <pattern>`     |
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
- Meta/analytics commands are always called directly on `rtk`: `rtk gain`, `rtk gain --history`, `rtk discover`, `rtk config`.
- If `rtk` filtering hides information you need (e.g. exact file contents with line numbers), re-run with the native command or `rtk read --level none -n`.
- Do not wrap commands that `rtk` does not support. If no rtk subcommand exists, run the native command directly.

⚠️ **Name collision:** if `rtk gain` fails, a different `rtk` (reachingforthejack/rtk, "Rust Type Kit") may be on `PATH`. Verify with `which rtk`; if it is the wrong binary, fall back to the native commands.

### 4. Memory — use the `oc2-memory` plugin **frequently**

`oc2-memory` is installed in this environment and is the global, cross-project memory layer. Use it by default, not as a last resort: an agent that never reads or writes memory re-derives context that already exists and loses decisions that were already made.

**Read before you work:**

- `memory_search` — before planning non-trivial work, search for prior decisions, gotchas, project facts, and user preferences.
- `memory_read` — pull a specific file (`long_term`, `scratchpad`, `daily`, `list`) when you need the full text.

**Write when you learn something durable:**

- `memory_write` with `target: "long_term"` — decisions, architecture facts, conventions, user preferences, recurring bug classes. Append mode is the default; search first so you do not duplicate.
- `memory_write` with `target: "daily"` — session progress, open threads, transient notes.
- `scratchpad` (`add` / `done` / `undo` / `clear_done` / `list`) — small "fix later" items you do not want to lose mid-task. If `SCRATCHPAD.md` does not exist yet, create it first, then use it.

**Maintain:**

- `memory_status` — health check: where files live, qmd / collection / embeddings state.
- `memory_forget` / `memory_restore` — remove outdated or wrong facts, then restore them via the returned recovery ID if needed.

**Where it lives (global, not per project):** `~/.pi/agent/memory/` — `MEMORY.md` (long-term), `SCRATCHPAD.md`, daily logs. `SCRATCHPAD.md` is created on first use if it is missing. Falls back to `~/.oc2-memory/` when the pi directory does not exist; `PI_MEMORY_DIR` overrides both.

**Rules:**

- **Before a decision, search.** Whenever a decision is coming up — architecture, library choice, convention, workflow, trade-off — run `memory_search` first with a few relevant keywords. Prior context may already settle it.
- **When a decision is made or a new insight appears, store it.** Do not leave it in the chat: `memory_write` the decision (what, why, alternatives rejected) or the finding, while the context is still fresh.
- Write facts and decisions, not narration — one self-contained entry per item.
- Prefer the plugin over ad-hoc notes in chat or in scratch files.

## Security

Never commit real memory files or secrets. Tests take credentials from the environment
(`OPENAI_API_KEY`).
