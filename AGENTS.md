# Repository Guidelines

An **OpenCode V2 plugin** that gives the coding agent a memory: durable facts, a daily log, and a
scratchpad, all as plain markdown, with optional qmd-powered search. It is a port of
[pi-memory](https://github.com/jayzeng/pi-memory) — a pi extension — onto OpenCode's V2 plugin SDK,
`@opencode/plugin`.

**The port is complete on OpenCode V2.** Phases 0–3 are done: `index.ts` is a pure V2 plugin — the
seven tools with JSON-Schema inputs, the byte-stable snapshot, and the compaction handoff — with
**no** `@earendil-works/pi-*` dependency. Outstanding: Phase 4 (configuration and docs), Phase 5
(release), and Phase 6 (the `npx` installer CLI). See `PLAN.md`.

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

- **Finding files and code** — the `fff` MCP tools (`find_files`, `grep`, `multi_grep`) instead of
  `ls`, `find`, or `rg`. Fall back to a shell command only where `fff` cannot express it.
- **Library and API questions** — look them up, never guess. `context7` (`resolve-library-id`, then
  `query-docs`) first for API syntax, configuration and current examples. `deepwiki`
  (`read_wiki_structure` / `read_wiki_contents`) when `context7` has no coverage or the question is a
  repository's internals, architecture or rationale. Prior knowledge only once both are exhausted or
  the API is trivial and stable.
- **Shell commands** — prefix with `rtk`, whose subcommands mirror the native tool: `rtk git status`,
  `rtk npm install`, `rtk grep -i foo src/`. Meta commands stay bare: `rtk gain`, `rtk config`.
  Check once per session with `rtk --version`; if that fails, or `which rtk` names "Rust Type Kit",
  run native commands for the rest of the session.

## Security

Never commit real memory files or secrets. Tests take credentials from the environment
(`OPENAI_API_KEY`).
