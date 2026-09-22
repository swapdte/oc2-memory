# oc2-memory — Entwicklungsplan

Port von [pi-memory](https://github.com/jayzeng/pi-memory) als **Opencode-V2-Plugin**.

- Autor: **swapdte** · Co-Autor: **opencode** · Lizenz: **MIT**
- Grundlage: `DECISIONS.md` (alle technischen Entscheidungen) + Quellcode `index.ts` (pi-memory).
- Vorgehen: TDD (red → green → refactor), siehe `AGENTS.md`.
- **Ziel-API: `@opencode/plugin@2.0.2` (V2).** Kein V1-Fallback. Siehe `DECISIONS.md` → API-Lage.

**Aktuelle Phase: 1.** Phase 0 ist abgeschlossen (Commits `7143882`, `b4cbe77`; Gate erfüllt,
`npm test` 198/198 grün). Phase 1 ist noch nicht begonnen.

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
- [x] `tsconfig.json`: `noEmit` bleibt für den Typecheck; `dist` wird ausgeschlossen
      (via `exclude`, nicht `include`).
- [x] `README.md` auf oc2-memory umschreiben — **erklärt die Portierung auf die
      Opencode-V2-Plattform**, Autoren: swapdte + Jay Zeng (Original). Install via
      `opencode plugin add oc2-memory` (später; bis dahin git-Spec).
- [x] `AGENTS.md`: „kein Build-Step“-Konvention angepasst (`tsup` ist die Ausnahme);
      Ziel-API auf V2, `npm install`-Hinweis bleibt.
- [ ] `.github/workflows/`: **bewusst zurückgestellt.** `ci.yml`, `publish-npm.yml` und
      `e2e.yml` funktionieren unverändert, weil die pi-Deps bleiben; `windows-qmd-smoke.yml`
      testet pi-spezifische Helfer und wandert mit dem Port (Phase 3/4).
- **Gate — erfüllt:** `git log` zeigt pi-History, `origin` zeigt swapdte/oc2-memory,
  `npm run build` läuft; zusätzlich `npm test` 198/198 grün.

Zusätzlich in Phase 0 gefunden und behoben: Biome lintete das generierte `dist/index.d.ts`
und ließ damit den neuen Build-Schritt den pre-commit-Hook bei **jedem** Commit abbrechen —
`biome.json` schließt `dist` jetzt aus (`7143882`). Test-Leiche aufgeräumt: ein Test las das
gelöschte `CLAUDE.md`; er prüft jetzt die oc2-memory-Identität.

### Phase 1 — Kern (Datei-Hooks, Pfad, qmd)
Port aus `index.ts`:
- [ ] `resolveMemoryDir`/Pfad-Fallback: `PI_MEMORY_DIR` → `~/.pi/agent/memory/`
      (nur Basisordner-Existenz) → `~/.oc2-memory/`; einmal erkennen, cachen.
- [ ] Datei-Utilities: `ensureDirs`, `readFileSafe`, `todayStr`/`yesterdayStr`,
      `nowTimestamp`, `shortSessionId` (unverändert übernehmen).
- ~~**Serialisierungs-Queue** (`Map<string, Promise>`) um alle Diskmutationen und
  Snapshot-Builds (`DECISIONS.md` §10)~~ — **in Phase 1 als gegenstandslos verworfen.**
  Alle Diskmutationen in `index.ts` sind synchron (`writeFileSync`; kein `appendFileSync`/
  `writeFile`/`appendFile`), und zwischen Lesen und Schreiben wird nie `await`et — der
  Read-Modify-Write ist damit in-process atomar. Siehe `DECISIONS.md` §10, inklusive der
  noch offenen Detailprüfung der übrigen Write-Stellen. **Regel bleibt: kein `await`
  zwischen Lesen und Schreiben.**
- [ ] qmd-Wrapper: `detectQmd`, `checkCollection`, `setupQmdCollection`,
      `search`, `update`, `embed` (Shell-Out an qmd bleibt identisch).
      Fehlendes qmd → sauberer Markdown/Grep-Fallback, kein Fehler.
- **Gate:** `bun test` (Unit-Tests auf die portierten Utilities; Backups/Restores intakt).

### Phase 2 — Plugin-Gerüst + Injection
- [ ] Server-Plugin-Modul: Default-Export `{ id: "oc2-memory", setup }` (plus benannter
      `setup`); `setup(ctx)` registriert alle Hooks und gibt ein Cleanup zurück,
      das die Maps leert.
- [ ] `ctx.session.hook("context", …)`:
  - Snapshot beim ersten Feuern pro `sessionID` bauen (MEMORY + Scratchpad +
    heute + gestern; Längen-Caps wie pi, MEMORY.md mittig gekürzt).
  - Block trägt eine **Sentinel-Zeile**; bei jedem Feuern in `event.system` suchen,
    gefunden → in place ersetzen, sonst anhängen; `event.system` neu zuweisen.
  - Cache `Map<sessionID, {snapshot, part, dayKey, dirty}>`; Re-Build **nur** bei
    Dirty-Flag oder Tageswechsel.
  - **keine Zeitstempel im Block** (Byte-Stabilität).
  - **Gate-Punkt (empirisch):** feuert `context` auch für `kind ≠ "primary"`
    (Titel-Generator, Summarizer)? Falls ja, auf das Kind-Feld gaten. Erst messen,
    dann entscheiden — nicht annehmen.
- [ ] `ctx.event.subscribe({ signal })`: `session.created` → qmd-Detect/-Setup +
      Snapshot-Init; einmal pro Session `console.warn("[oc2-memory] …")`.
- [ ] `ctx.session.hook("compaction", …)` → Handoff als System-Part anhängen
      (Header + offene Scratchpad-Items + Tages-Tail, eigener Cap); zusätzlich
      Handoff-Block in die Tagesdatei persistieren. **`result` nicht setzen.**
      Handoff-Write setzt **nicht** das Dirty-Flag.
- **Gate:** manuell `opencode` starten → Speicherblock erscheint im Kontext;
  `memory_write` (daily) ändert den Block **nicht** (byte-stabil); Block erscheint
  auch bei wiederholten Anfragen **nur einmal** (Sentinel-Idempotenz).

### Phase 3 — Tools portieren (TDD)
Reihenfolge nach Abhängigkeit, je Tool rote Tests zuerst:
- [ ] `memory_write` (long_term/daily, append/overwrite)
- [ ] `memory_read` (Dateien + `list` der Tageslogs)
- [ ] `scratchpad` (add/done/undo/clear/list)
- [ ] `memory_forget` + `memory_restore` (recovery-`<id>.json`), setzt Dirty-Flag
      für **alle** lebenden Sessions
- [ ] `memory_search` (qmd keyword/semantic/deep; Markdown-Fallback als Default)
- [ ] `memory_status` (Doctor: Pfade, qmd, Collection, Embeddings, Konfig
      **+ Snapshot-Zustand**: geladen/stale, Byte-Größe, letzter Refresh, Dirty-Flag)
- [ ] Registrierung via `ctx.tool.transform(editor => editor.add({ name, description,
      input: <JSON Schema>, execute }))`; `execute`-Rückgabe `{ content }` / `Tool.Result`.
- **Gate:** alle Unit-/E2E-Tests grün; Tool-Verhalten identisch zu pi (Files,
  Cross-Session-Recall).

### Phase 4 — Konfig & Doku
- [ ] Env-Vars übernehmen/reduzieren (nur nötige: `PI_MEMORY_DIR`,
      `PI_MEMORY_QMD_UPDATE`, Timeouts; `per-turn`/Exit-Summary-Vars entfallen).
- [ ] `README.md` final: Install, Tools, Datei-Layout, Troubleshooting, Konfig,
      **Autoren-Abschnitt** (swapdte + Jay Zeng), Portierungs-Hinweis.
- [ ] `AGENTS.md` final gegen den echten Stand abgleichen (Build-Step, V2-API,
      Test-Kommandos).
- [ ] `DECISIONS.md` + `PLAN.md` ins Repo committen.

### Phase 5 — Release
- [ ] `npm run build` (tsup + Typecheck) + `lint` grün.
- [ ] `prepublishOnly: "npm run build"` ergänzen — das Tarball **muss** `dist/` enthalten.
      `files` listet es, Git ignoriert es: zwei getrennte Mechanismen.
- [ ] Tag `v0.1.0`; Publish-Workflow anpassen (npm, `dist/` in `files`) falls gewollt.
- [ ] Install-Smoke-Test **npm**: `opencode plugin add oc2-memory`.
- [ ] Install-Smoke-Test **lokal** (dev): `plugins: ["/abs/…/dist"]` in der globalen
      Config. Der Pfad muss ein **Verzeichnis** sein (eine bloße Datei wird verworfen);
      `Host.resolve` sucht darin `server.*` dann `index.*` — bei lokalen Verzeichnissen
      wird `package.json` **nicht** gelesen. Alternative: gebaute `dist/index.js` nach
      `~/.config/opencode/plugins/` kopieren (wird nach `.js`/`.ts` gescannt).
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
- [ ] `bin`-Feld + zweites Build-Target für die CLI, als **Node-kompatibles**
      Bundle, damit `npx oc2-memory …` auch ohne Bun funktioniert.
- [ ] `npx oc2-memory install` — Eintrag in die `plugins`-Liste der globalen Config
      schreiben: idempotent, atomar (tmp + rename), Modus 0600. Option `--local <dir>`:
      baut bei Bedarf und trägt den **`dist/`-Verzeichnispfad** ein — der einzige
      Installationsweg, den `opencode plugin add` verweigert.
- [ ] `npx oc2-memory uninstall` — Eintrag entfernen. Hinweis ausgeben: das Paket
      bleibt unter `~/.cache/opencode/npm/…` liegen (OpenCode löscht den Cache nicht).
- [ ] `npx oc2-memory status` — Doctor: Config-Eintrag vorhanden?, gewählter
      Speicherordner (pi-Pfad vs. Fallback), qmd vorhanden?, Collection, Embeddings.
- **Gate:** `npx oc2-memory install` in einer sauberen Config → OpenCode lädt das
  Plugin; `status` zeigt den Eintrag; `uninstall` entfernt ihn wieder.
- Erst nach Phase 5 sinnvoll: die CLI setzt das veröffentlichte npm-Paket mit
  `dist/` voraus.

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
  landen N Kopien im Prompt.
- **Interne Aufrufe** — prüfen, ob `context` auch für nicht-`primary`-Requests feuert
  (Phase-2-Gate); sonst Leak in Titel-/Summary-Prompts.
- **Nebenläufigkeit** — viele Sessions, gemeinsame Tagesdatei: alle Diskmutationen
  durch die Queue (§10).
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
