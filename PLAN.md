# oc2-memory — Entwicklungsplan

Port von [pi-memory](https://github.com/jayzeng/pi-memory) als **Opencode-V2-Plugin**.

- Autor: **swapdte** · Co-Autor: **opencode** · Lizenz: **MIT**
- Grundlage: `DECISIONS.md` (alle technischen Entscheidungen) + Quellcode `index.ts` (pi-memory).
- Vorgehen: TDD (red → green → refactor), siehe `AGENTS.md`.
- **Ziel-API: `@opencode/plugin@2.0.2` (V2).** Kein V1-Fallback. Siehe `DECISIONS.md` → API-Lage.

**Status: alle Phasen (0–6) abgeschlossen — released.** `oc2-memory@0.1.1` ist seit 2026-09-22
auf npm veröffentlicht und dort `latest` (Tags `v0.1.0`, `v0.1.1`). `index.ts` ist ein reines
V2-Plugin **ohne** `@earendil-works/pi-*`-Abhängigkeit; `bin/cli.ts` liefert
`npx oc2-memory install|uninstall|status` (Node-kompatibel). `npm test` 202/202 grün,
`dist/index.js` enthält keine pi-Referenz. Offen ist nichts mehr; neue Arbeit beginnt als eigener
Abschnitt unterhalb der Phasen.

---

## Zielbild

Ein **Server-Plugin** (`oc2-memory`), das pi-memorys Markdown-Speicher
(`~/.pi/agent/memory/`, Fallback `~/.oc2-memory/`) für Opencode nutzt:

- 7 Tools (`memory_write`, `memory_forget`, `memory_restore`, `memory_read`,
  `scratchpad`, `memory_search`, `memory_status`) — 1:1 portiert, registriert via
  `ctx.tool.transform(editor => editor.add({…}))` mit JSON-Schema-`input`.
- Speicherblock-Injection + Refresh über `ctx.session.hook("context", …)`
  (byte-stabil, Sentinel-Ersetzung, Refresh nur bei Dirty-Flag/Tageswechsel).
- Compaction-Handoff über `ctx.session.hook("compaction", …)` (System-Part anhängen,
  `result` bleibt unberührt).
- qmd-Suche unverändert, bestehende `pi-memory`-Collection wiederverwenden,
  Markdown-Fallback als Default.
- Paketierung: `tsup` → `dist/index.js`, Default-Export `{ id, setup }`.

**Nicht gebaut:** `per-turn`-Modus, Exit-Summary, Ctrl+D-Erkennung, TUI-Plugin,
V1-`server`-Fallback, Toast-Benachrichtigung. Siehe `DECISIONS.md` §5/§9/§O3.

---

## Phasen

### Phase 0 — Repo-Setup
- [x] Neues, **leeres** GitHub-Repo `oc2-memory` (Autor swapdte).
- [x] Lokal: `git remote rename origin upstream`; `origin` → `swapdte/oc2-memory`.
- [x] `git push --mirror origin` (volle History) + `--set-upstream origin main`.
- [x] `LICENSE` = MIT (jayzeng-Copyright erhalten, eigene Zeile für oc2-memory).
- [x] `package.json` auf V2: (`b4cbe77`)
  - `name: "oc2-memory"`, `description`, `author: "swapdte"`, `license: "MIT"`, `type: "module"`
  - `main` + `exports`: `{ ".": "./dist/index.js", "./server": "./dist/index.js" }`
  - **kein** `opencode`-Feld (existiert nicht); pi-Feld `pi` entfernt
  - `tsup` als devDependency, `@opencode/plugin@2.0.2` als devDependency (nur Typen)
  - Scripts: `build` = tsup **und** `tsc --noEmit`, `lint`, `test`, `test:e2e`, `test:eval`
  - Abweichung vom Plan: die `@earendil-works/pi-*`-Deps **bleiben** (dev + peer), weil
    `index.ts` und die Tests sie noch brauchen — sie fallen erst mit dem Port in Phase 3.
    → **In Phase 3 erledigt:** beide Deps aus dev- und peerDependencies entfernt
    (inkl. Lockfiles); `index.ts` enthält kein `@earendil-works` mehr.
- [x] `tsconfig.json`: `noEmit` bleibt für den Typecheck; `dist` wird ausgeschlossen
      (via `exclude`, nicht `include`).
- [x] `README.md` auf oc2-memory umschreiben — **erklärt die Portierung auf die
      Opencode-V2-Plattform**, Autoren: swapdte + Jay Zeng (Original). Install via
      `opencode plugin add oc2-memory` (später; bis dahin git-Spec).
- [x] `AGENTS.md`: „kein Build-Step“-Konvention angepasst (`tsup` ist die Ausnahme);
      Ziel-API auf V2, `npm install`-Hinweis bleibt.
- [x] `.github/workflows/`: `ci.yml`, `publish-npm.yml` und `e2e.yml` funktionieren unverändert;
      `windows-qmd-smoke.yml` prueft jetzt den echten V2-Port-Vertrag (`resolveMemoryDir` pur,
      `resolveActiveMemoryDir`-Fallback, `ensureDirs`/`dailyPath` via `_setBaseDir(tmp)`) und
      nicht mehr den unbedingten pi-Pfad.
- **Gate — erfüllt:** `git log` zeigt pi-History, `origin` zeigt swapdte/oc2-memory,
  `npm run build` läuft; zusätzlich `npm test` 198/198 grün.

Zusätzlich in Phase 0 gefunden und behoben: Biome lintete das generierte `dist/index.d.ts`
und ließ damit den neuen Build-Schritt den pre-commit-Hook bei **jedem** Commit abbrechen —
`biome.json` schließt `dist` jetzt aus (`7143882`). Test-Leiche aufgeräumt: ein Test las das
gelöschte `CLAUDE.md`; er prüft jetzt die oc2-memory-Identität.

### Phase 1 — Kern (Datei-Hooks, Pfad, qmd)
Port aus `index.ts`:
- [x] `resolveMemoryDir`/Pfad-Fallback: `PI_MEMORY_DIR` → `~/.pi/agent/memory/`
      (nur Basisordner-Existenz) → `~/.oc2-memory/`; einmal erkennen, cachen.
- [x] Datei-Utilities: `ensureDirs`, `readFileSafe`, `todayStr`/`yesterdayStr`,
      `nowTimestamp`, `shortSessionId` (unverändert übernehmen).
- ~~**Serialisierungs-Queue** (`Map<string, Promise>`) um alle Diskmutationen und
  Snapshot-Builds (`DECISIONS.md` §10)~~ — **in Phase 1 als gegenstandslos verworfen.**
  Alle Diskmutationen in `index.ts` sind synchron (`writeFileSync`; kein `appendFileSync`/
  `writeFile`/`appendFile`), und zwischen Lesen und Schreiben wird nie `await`et — der
  Read-Modify-Write ist damit in-process atomar. Siehe `DECISIONS.md` §10, inklusive der
  noch offenen Detailprüfung der übrigen Write-Stellen. **Regel bleibt: kein `await`
  zwischen Lesen und Schreiben.**
- [x] qmd-Wrapper: `detectQmd`, `checkCollection`, `setupQmdCollection`,
      `search`, `update`, `embed` (Shell-Out an qmd bleibt identisch).
      Fehlendes qmd → sauberer Markdown/Grep-Fallback, kein Fehler.
- **Gate:** `bun test` (Unit-Tests auf die portierten Utilities; Backups/Restores intakt).

### Phase 2 — Plugin-Gerüst + Injection
- [x] Server-Plugin-Modul: Default-Export `{ id: "oc2-memory", setup }` (plus benannter
      `setup`); `setup(ctx)` registriert alle Hooks und gibt ein Cleanup zurück,
      das die Maps leert.
- [x] `ctx.session.hook("context", …)`:
  - Snapshot beim ersten Feuern pro `sessionID` bauen (MEMORY + Scratchpad +
    heute + gestern; Längen-Caps wie pi, MEMORY.md mittig gekürzt).
  - Block trägt eine **Sentinel-Zeile**; bei jedem Feuern in `event.system` suchen,
    gefunden → in place ersetzen, sonst anhängen; `event.system` neu zuweisen.
  - Cache `Map<sessionID, {block, dayKey, dirty}>`; Re-Build **nur** bei
    Dirty-Flag oder Tageswechsel.
  - **keine Zeitstempel im Block** (Byte-Stabilität).
  - **Gate-Punkt (empirisch):** `context` wird **nur** registriert; Titel-/Summary-/
    Generate-Requests haben eigene Hooks (`title`/`generate`/`compaction`), es wird
    nichts dorthin injiziert.
- [x] `ctx.event.subscribe({ signal })`: `session.created` → qmd-Detect/-Setup +
      Snapshot-Init; einmal pro Session `console.warn("[oc2-memory] …")`.
- [x] `ctx.session.hook("compaction", …)` → Handoff als System-Part anhängen
      (Header + offene Scratchpad-Items + Tages-Tail, eigener Cap); zusätzlich
      Handoff-Block in die Tagesdatei persistieren. **`result` nicht setzen.**
      Handoff-Write setzt **nicht** das Dirty-Flag.
- **Gate — erfüllt:** Unit-Tests decken Block-Anhängen/-Ersetzen, Byte-Stabilität,
  Dirty-Rebuild, Tageswechsel und Compaction-Handoff ab (`V2 setup`-Suite).

### Phase 3 — Tools portieren (TDD)
Reihenfolge nach Abhängigkeit, je Tool rote Tests zuerst:
- [x] `memory_write` (long_term/daily, append/overwrite)
- [x] `memory_read` (Dateien + `list` der Tageslogs)
- [x] `scratchpad` (add/done/undo/clear/list)
- [x] `memory_forget` + `memory_restore` (recovery-`<id>.json`), setzt Dirty-Flag
      für **alle** lebenden Sessions
- [x] `memory_search` (qmd keyword/semantic/deep; Markdown-Fallback als Default)
- [x] `memory_status` (Doctor: Pfade, qmd, Collection, Embeddings, aktive Konfig)
- [x] Registrierung via `ctx.tool.transform(editor => editor.add({ name, description,
      input: <JSON Schema>, execute }))`; die sieben Definitionen sind als
      `MEMORY_TOOLS` exportiert, `execute` liefert intern `{ content, isError?, details }`
      und wird erst am V2-Rand via `toOpenCodeTool` auf `Tool.Result`
      (`content: string`, `metadata`) abgebildet.
- [x] pi-Oberfläche vollständig entfernt: `registerExtension`, alle `pi.registerTool`/
      `pi.on`-Aufrufe, der `ExtensionAPI`-Import und die komplette Exit-Summary
      (`complete`/`convertToLlm`/`serializeConversation`, `PI_MEMORY_EXIT_SUMMARY*`).
      `package.json` frei von `@earendil-works/pi-*`; `dist/index.js` ohne pi-Referenz.
- **Gate — erfüllt:** alle Unit-Tests grün; kein `@earendil-works` in `index.ts`,
  `package.json` oder `dist/index.js`.

### Phase 4 — Konfig & Doku
- [x] Env-Vars reduziert: nur `PI_MEMORY_DIR`, `PI_MEMORY_QMD_UPDATE`,
      `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS`, `PI_MEMORY_EMBED_PROBE_TIMEOUT_MS`.
      `PI_MEMORY_SNAPSHOT` (inkl. `getSnapshotMode()`) entfernt — der V2-`context`-Hook
      ist per Design immer byte-stabil; `per-turn`/`refresh` steuern nichts mehr.
- [x] `README.md` final: Install, Tools, Datei-Layout, Troubleshooting, Konfig,
      **Autoren-Abschnitt** (swapdte + Jay Zeng), Portierungs-Hinweis.
- [x] `AGENTS.md` final gegen den echten Stand abgleichen (Build-Step, V2-API,
      Test-Kommandos, Doku-Status).
- [x] `DECISIONS.md` + `PLAN.md` ins Repo committen (deutsch; Status auf Phase 5).

### Phase 5 — Release — **erledigt**
- [x] `npm run build` (tsup + Typecheck) + `lint` grün. Der `publish-npm.yml`-Workflow fährt
      `lint` → `build` → `test` vor `npm publish` und ist damit das Gate.
- [x] `prepublishOnly: "npm run build"` ergänzt (`package.json`) — das Tarball **muss** `dist/`
      enthalten. `files` listet es, Git ignoriert es: zwei getrennte Mechanismen.
- [x] Tag `v0.1.0` (`f82a43a`) und `v0.1.1` (`95d6832`); Publish-Workflow auf npm umgestellt,
      Publishing via **Trusted Publishing (OIDC)** statt `NPM_TOKEN` (`24a6805`, `428281b`,
      `661ac1f`). `v0.1.1` ist npm-`latest`.
- [x] Install-Smoke-Test **npm**: `opencode plugin add oc2-memory` bzw. `npx oc2-memory install`.
- [x] Install-Smoke-Test **lokal** (dev): `plugins: ["/abs/…/dist"]` in der globalen
      Config. Der Pfad muss ein **Verzeichnis** sein (eine bloße Datei wird verworfen);
      `Host.resolve` sucht darin `server.*` dann `index.*` — bei lokalen Verzeichnissen
      wird `package.json` **nicht** gelesen. Alternative: gebaute `dist/index.js` nach
      `~/.config/opencode/plugins/` kopieren (wird nach `.js`/`.ts` gescannt). Der
      `--local`-Weg ist der Installationsweg, den `opencode plugin add` verweigert; das
      Phase-6-Gate deckt ihn ab.
- **Hinweis zu den Tags:** `v0.3.5`, `v0.3.6` und `v0.4.2` stammen aus der gespiegelten
  **pi-memory**-Historie (Upstream), nicht aus oc2-memory-Releases. Die oc2-memory-Releases
  sind ausschließlich `v0.1.0` / `v0.1.1`.
- **Verifiziert unmöglich (v2.0.8): `opencode plugin add <git-Spec>` für dieses Repo.**
  `plugin add` installiert über arborist mit `ignoreScripts: true` → **kein `prepare`**;
  `dist/` ist gitignored → kein Einstiegspunkt → „Plugin package has no server or TUI
  entrypoint". Ein `prepare`-Script hilft hier also **nichts**. Wege: npm (bevorzugt)
  oder `dist/` committen (nicht gewollt).
- Hinweis fürs README: `opencode plugin remove <spec>` löscht nur den Config-Eintrag;
  das Paket bleibt in `~/.cache/opencode/npm/…` liegen. `opencode plugin dev` existiert
  in 2.0.8 **nicht** (dcps gleichnamiges Script ist kaputt).

### Phase 6 — Installer-CLI (Installation per `npx`)
Entschieden: die Installation läuft über **npx** (nicht bunx). Das Paket wird damit
zum Doppelwesen wie `oh-my-opencode-slim` — `main` = Plugin, `bin` = CLI.
- [x] `bin`-Feld + zweites Build-Target für die CLI, als **Node-kompatibles**
      Bundle, damit `npx oc2-memory …` auch ohne Bun funktioniert.
- [x] `npx oc2-memory install` — Eintrag in die `plugins`-Liste der globalen Config
      schreiben: idempotent, atomar (tmp + rename), Modus 0600. Option `--local <dir>`:
      baut bei Bedarf und trägt den **`dist/`-Verzeichnispfad** ein — der einzige
      Installationsweg, den `opencode plugin add` verweigert.
- [x] `npx oc2-memory uninstall` — Eintrag entfernen. Hinweis ausgeben: das Paket
      bleibt unter `~/.cache/opencode/npm/…` liegen (OpenCode löscht den Cache nicht).
- [x] `npx oc2-memory status` — Doctor: Config-Eintrag vorhanden?, gewählter
      Speicherordner (pi-Pfad vs. Fallback), qmd vorhanden?, Collection, Embeddings.
- **Gate — erfüllt:** `node dist/cli.js install` / `status` / `uninstall` wurden gegen
  eine isolierte Config (`HOME`/`XDG_CONFIG_HOME` auf ein Temp-Verzeichnis) ausgeführt;
  `install` ist idempotent, `--local .` registriert den absoluten `dist/`-Pfad,
  `uninstall` entfernt beide, kaputtes JSON bricht ohne Überschreiben ab. Läuft unter
  **Node**, ohne Bun.
- [x] Erst nach Phase 5 sinnvoll: die CLI setzt das veröffentlichte npm-Paket mit `dist/` voraus.
  → **Erledigt:** `oc2-memory@0.1.1` ist auf npm, damit funktioniert `npx oc2-memory install`.


---

## Nicht-Ziele (bewusst gestrichen)
- `per-turn`-Modus & selektive Search-Injection (DECISIONS §5).
- Exit-Summary / Ctrl+D-Erkennung (DECISIONS §O3).
- Separates TUI-Plugin und Toast-Benachrichtigung — V2-Server-Context hat kein
  `client`/`toast`/`log`; Ersatz ist `console.warn` + `memory_status` (§O3).
- V1-`server`-Fallback für Opencode < 2.x (§9).

## Risiken / Watchlist
- **Byte-Stabilität** — kein Zeitstempel, kein „zuletzt aktualisiert“, keine
  ordnungsabhängige Ausgabe im Snapshot; nur Dirty-Flag/Tageswechsel rebuildet.
  Ehrliche Reichweite: nur *unser* Beitrag ist byte-konstant, nicht der ganze Prefix.
- **Doppel-Injection** — der `context`-Hook feuert pro Anfrage; ohne Sentinel-Prüfung
  landen N Kopien im Prompt. Abgedeckt durch Unit-Tests (genau ein Sentinel).
- **Interne Aufrufe** — `context` wird nur registriert; Titel-/Summary-/Generate-Requests
  haben eigene Hooks → kein Leak in deren Prompts (Phase-2-Gate erledigt).
- **Nebenläufigkeit** — viele Sessions, gemeinsame Tagesdatei: alle Diskmutationen sind
  synchron und ohne `await` zwischen Lesen und Schreiben; die in §10 verworfene Queue ist
  gegenstandslos.
- **Globaler Speicher, Session-Cache** — `memory_forget`/`memory_restore` müssen
  **jede** lebende Session invalidieren, nicht nur die aufrufende.
- **qmd nicht überall** — Collection `pi-memory` fehlt auf frischen Installationen;
  Markdown-Fallback ist Default, qmd Opt-in.
- **Export-Form** — Host lädt das Modul-Namespace; Default-Export `{ id, setup }` plus
  benannter `setup` (wie codemem), nicht auf `define()` allein verlassen.
- **Doku-Drift** — `opencode.ai/docs` beschreibt V1 und ist für 2.0.8 falsch
  (Hook-Namen, Config-Key `plugin`, `opencode plugin <repo>`). Gegen lokale `.d.ts`
  und `--help` prüfen.
- **GitHub-Auth beim Push** (HTTPS+PAT oder SSH), Forgejo-Setup nicht anfassen.
