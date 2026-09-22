# oc2-memory — Entscheidungsprotokoll

Ein Port von [pi-memory](https://github.com/jayzeng/pi-memory) als **Opencode-V2-Plugin**.
Diese Datei listet alle getroffenen Entscheidungen und offenen Punkte.

Statuswerte: `entschieden` · `offen`.

---

## Kontext

- Quelle: `pi-memory` (Single-File `index.ts`, ~2500 Zeilen, pi-Hook-API).
- Ziel: V2-Plugin für Opencode, SDK **`@opencode/plugin@2.0.2`**.
- Anwender nutzt zusätzlich **opencode-dcp** (auto-compaction). → relevant für Compaction-Handoff.

### API-Lage (lokal verifiziert)

Opencode 2.0.8 führt **zwei** Plugin-APIs parallel:

| | V1 (legacy) | V2 (Ziel) |
| --- | --- | --- |
| Paket | `@opencode-ai/plugin` (bis 1.18.31) | `@opencode/plugin` (2.0.2) |
| Modul | Default-Export `{ id?, server, tui? }` | Default-Export `define({ id, setup })` |
| Hooks | flach: `"experimental.chat.system.transform"`, `"experimental.session.compacting"`, `event`, `tool` | imperativ: `ctx.session.hook("context" \| "compaction", …)`, `ctx.event.subscribe(…)`, `ctx.tool.transform(…)` |
| Config-Key | `plugin` | `plugins` (Plural) |
| Doku | `opencode.ai/docs/plugins` beschreibt **diese** Form | noch nicht öffentlich dokumentiert |

**Welche API ist die richtige?** Beide laufen. Ein Modul darf beide gleichzeitig bedienen —
dcp exportiert real `{ id, setup, server }`: `{ id, setup }` für V2, `server` als V1-Fallback.

**Ziel ist trotzdem ausschließlich V2.** Gründe: die V1-Namen sind zwar noch typisiert und
lauffähig, aber die alte Oberfläche; V2 ist die Oberfläche, gegen die neue Plugins gebaut
werden (dokumentiertes `define`/`setup`, JSON-Schema-Tools nativ, erstklassige
Request-Kind-Unterscheidung). Ein V1-Adapter würde eine **zweite** Hook-Oberfläche mit
abweichender Injection-Semantik für dieselben 7 Tools bedeuten — echter Aufwand ohne
aktuellen Nutzer. **Kein V1-`server`-Fallback.**

> ⚠️ Die öffentliche Doku unter `opencode.ai/docs` ist für 2.0.8 **veraltet** (V1-Form,
> Config-Key `plugin`, `opencode plugin <repo>`). Bei Zweifeln gegen die lokalen
> `.d.ts`-Dateien oder `opencode <cmd> --help` prüfen, nicht gegen die Doku.

---

## Entscheidungen

### 1. Name
`oc2-memory` — `entschieden`

Klar, versioniert, kollidiert weder mit `pi` noch mit anderen Systemen.

### 2. Speicherpfad & Fallback
`entschieden`

- **Fallback-Regel:** Zugriff zuerst auf `~/.pi/agent/memory/`.
  Nur wenn der **Basisordner** nicht existiert → `~/.oc2-memory/` anlegen und nutzen.
- Erkennung **einmal beim ersten Zugriff**, dann Pfad für die Session cachen
  (nicht bei jedem Tool-Aufruf neu prüfen).
- Ziel: volle Rückwärtskompatibilität & Daten-Sharing mit bestehender pi-Installation;
  eigener Bereich nur, wenn nie pi-Daten existieren.

### 3. Wann gilt „existiert“?
`entschieden`

- Es wird **nur die Existenz des Basisordners** geprüft, nicht einzelner Dateien
  (`MEMORY.md` o. ä.).
- Ein leerer `~/.pi/agent/memory/`-Ordner gilt als pi-Speicher (kein Neuaufbau),
  damit eine leere pi-Installation die OC2-Erinnerungen nicht trennt.

### 4. `PI_MEMORY_DIR` respektieren
`entschieden`

- Der Env-Override aus pi-memory wird für Parität & Testbarkeit übernommen
  und hat **Vorrang vor** der Basisordner-Erkennung.
- Ohne ihn kann man nie isoliert testen.

### 5. Modus: `stable` statt `per-turn`
`entschieden`

- **Aufbau:** `stable`-Snapshot — ein Speicherblock (MEMORY + Scratchpad + heute +
  gestern) wird beim Session-Start injiziert und über die Session **byte-stabil** gehalten.
- **Injektions-Mechanismus:** `ctx.session.hook("context", …)`. Der Handler bekommt den
  Request mutabel: `{ sessionID, model, system, messages, options, agent, tools }`, wobei
  `system` ein **Part-Array** ist (`{ type: "text", text }[]`), kein String-Array.
  Wir hängen unseren Block als Text-Part an und weisen `event.system` neu zu.
- **Idempotenz (kritisch):** Der `context`-Hook feuert **pro Anfrage**, nicht pro Session —
  naives Anhängen erzeugt N Kopien. Deshalb trägt der Block eine **Sentinel-Zeile**;
  bei jedem Feuern wird `event.system` danach durchsucht: gefunden → **in place ersetzen**,
  nicht gefunden → anhängen. Nie zwei Kopien durchlassen.
- **Cache:** Modul-weites `Map<string, { snapshot, part, dayKey, dirty }>` **pro `sessionID`**
  (dasselbe Muster wie dcps Session-Queue). Rebuild nur wenn `dirty` **oder**
  `dayKey !== cached.dayKey` (Tageswechsel); danach `dirty` zurücksetzen.
- **Byte-Stabilität:** Der Block enthält **keine Zeitstempel**, kein „zuletzt aktualisiert“,
  keine ordnungsabhängigen Inhalte — alles Volatile würde die Byte-Gleichheit brechen und
  den Prefix-Cache kosten. Volatilität lebt ausschließlich hinter Dirty-Flag/Tageswechsel.
  Ehrliche Reichweite: garantiert ist nur, dass **unser** Beitrag byte-konstant ist —
  andere Plugins (dcp) schreiben `event.system` ebenfalls um, und die Message-History wächst.
- **Scope: pro Session, nicht pro Agent.** Memory ist global; ein `switchAgent` darf den
  Block nicht verwerfen. Der Agent ist kein Cache-Key.
- **Guard gegen interne Aufrufe:** Der heuristische `isInternalAgentCall`-Guard aus pi
  **entfällt** — V2 liefert mit `SessionRequestKind`
  (`"primary" | "compaction" | "title" | "generate"`) eine erstklassige Unterscheidung.
  Auxiliary-Requests haben **eigene Hooks** (`title`, `generate`, `compaction`). Der Guard
  ist damit strukturell: **nur `context` registrieren**, nichts in `title`/`generate` injizieren.
  → **Erledigt (Phase 2/3):** Es wird ausschließlich `context` registriert; Titel-,
  Summary- und Generate-Requests haben eigene Hooks (`title`/`generate`/`compaction`),
  in die nichts injiziert wird. Ein Kind-Gate ist damit nicht nötig.
- **`per-turn` wird gestrichen.** Kein „Pro-Prompt-Top-3-Search-Injection“-Modus.
- Begründung:
  - pi empfiehlt `stable` selbst als Default; Nutzen von `per-turn` (automatisches Recall)
    deckt das Modell über `memory_search` / `memory_read` auf Abruf ab.
  - **Korrektur einer früheren Fehlannahme:** Es hieß, V2 habe kein Äquivalent zu
    `before_agent_start`. Das ist falsch — `ctx.session.hook("context", …)` feuert bei jeder
    Chat-Anfrage und ist genau dieses Äquivalent. `per-turn` wäre also technisch abbildbar;
    es wird trotzdem **bewusst** gestrichen (Kosten/Nutzen), nicht aus Mangel an einem Hook.

### 6. qmd-Reihe unverändert
`entschieden`

- Shell-Out an externe qmd-CLI bleibt, inkl. `memory_search` (keyword/semantic/deep).
- **Bestehende Collection `pi-memory` über `~/.pi/agent/memory` wiederverwenden**
  (keine eigene Collection), da qmd format-agnostisch `**/*.md` indiziert.
- **qmd bleibt optional.** Auf einer frischen Installation existiert die Collection nicht.
  Der Markdown-/Grep-Fallback ist der **Default-Pfad**, qmd der Opt-in — `memory_search`
  muss ohne qmd sauber und nützlich antworten (Keyword-Suche über die Dateien), nicht
  fehlschlagen.

### 7. Tool-Set direkt portieren
`entschieden`

- Die 7 Tools (`memory_write`, `memory_forget`, `memory_restore`, `memory_read`,
  `scratchpad`, `memory_search`, `memory_status`) werden 1:1 portiert — sie sind
  agent-agnostisch (Datei-/qmd-Arbeit).
- **Registrierung (V2):** `ctx.tool.transform(editor => editor.add({ … }))`.
  `input` akzeptiert **JSON Schema nativ** (kein Zod-Zwang wie in V1).
  `execute(input, context)` mit `context: { sessionID, agent, messageID, id, progress }`.
- **Umsetzung (Phase 3):** Die sieben Definitionen liegen als **`MEMORY_TOOLS`** vor
  (host-agnostisch, interner Rückgabewert `{ content, isError?, details }`) und werden
  erst am V2-Rand über `toOpenCodeTool` auf `Tool.Result` abgebildet: `content` als
  **String**, `details` als `metadata`; `isError` wird als ablehnendes Promise signalisiert
  (der Promise-Adapter macht daraus einen Tool-Fehler). Die aus dem SDK abgeleiteten
  Typen (`ToolEditor`, `OpenCodeTool`) halten die Abbildung typgeprüft.
- **pi-Oberfläche entfernt (Phase 3):** kein `registerExtension`/`pi.registerTool`/`pi.on`,
  kein `@earendil-works/*` mehr — weder als Wert noch als Typ; `dist/index.js` enthält keine
  pi-Referenz.

### 8. Repo-Strategie & Lizenz
`entschieden`

- **Duplicate-Repo** (kein GitHub-Fork): volle History von `jayzeng/pi-memory` in ein
  neues, leeres Repo `oc2-memory` pushen; lokal `origin` ↔ neues Repo, `upstream` ↔
  jayzeng/pi-memory für selektive Cherry-Picks. Sauberes Repo, keine Upstream-PR-Falle,
  Attribution via History erhalten.
- **Lizenz: MIT.** Projekt startet unter MIT-Lizenz. Pflicht: Original-Copyright in
  `LICENSE` stehen lassen (jayzeng). Optional zusätzlich eigene Copyright-Zeile für
  oc2-memory-Anpassungen.
- **Autorenschaft:** Autor des Projekts = **swapdte**; Co-Autor = **opencode**.
- **Git/GitHub:** bestehende Identität (<user>/<email>) weiterverwenden, E-Mail ggf.
  auf die GitHub-Mail setzen (per `git config user.email` im Repo, `credential.helper=store`
  trennt Credentials pro Host). Auth: HTTPS + PAT oder separater SSH-Key.

### 9. Paketierung & Build
`entschieden`

- **Build-Schritt wird eingeführt** — Ausnahme von der pi-Konvention „`index.ts`, kein Build“.
  Grund: `@opencode/plugin`s `host.ts` löst Entrypoints als **Modulpfade** auf
  (`<name>/server`, dann `<name>`) und lädt sie per Import. Beide Referenz-Plugins bauen
  den Server-Entry nach JS (dcp: `dist/index.js`; codemem: `main: ./index.js`) und lassen
  nur den TUI-Entry roh. Der Host *kann* TS transpilieren, aber ein roher TS-Server-Entry
  bindet an undokumentierte Transpiler-Konfiguration; gebautes JS ist der bewiesene Pfad.
- **Werkzeug:** `tsup index.ts --format esm --dts` → `dist/index.js`. Quelle bleibt
  **eine Datei**, Artefakt bleibt **eine Datei** — der Geist von „self-contained“ bleibt.
- **`package.json`:** `"type": "module"`, `"main": "./dist/index.js"`,
  `"exports": { ".": "./dist/index.js", "./server": "./dist/index.js" }`.
  **Es gibt kein `opencode`-Feld** — Entrypoints werden über den Paketnamen aufgelöst.
- **Default-Export:** `{ id: "oc2-memory", setup }` (zusätzlich `setup` als benannter Export).
  Nicht auf `define()` allein verlassen — der Host konsumiert die **Objektform**; codemem
  ruft `define()` gar nicht auf.
- **Dependency:** `@opencode/plugin@2.0.2` als **devDependency** (nur Typen).
- **Ergänzung (Phase 3):** Die ursprünglich übergangsweise beibehaltenen
  `@earendil-works/pi-*`-Deps (dev + peer) sind entfernt; das Paket hat keine
  Runtime-Abhängigkeiten mehr.
- **Konsequenz:** `AGENTS.md` („kein Build-Step“) und `tsconfig.json` (`noEmit`) müssen
  angepasst werden; die `.github/workflows` bauen künftig vor dem Veröffentlichen.

### 10. Nebenläufigkeit
`entschieden` — **revidiert in Phase 1: die Queue ist gegenstandslos**

- pi war Ein-Session. V2 fährt **viele Sessions parallel**, und Requests innerhalb einer
  Session könnten auf dieselbe Tagesdatei treffen (Read-Modify-Write des Snapshots bzw.
  Append am Tageslog).
- **Ursprüngliche Regel (aufgehoben):** alle Diskmutationen und Snapshot-Builds durch eine
  **Serialisierungs-Queue pro Datei** (`Map<string, Promise>`, wie dcps `serial(...)`).
- **Befund (Phase 1, `index.ts` geprüft):** Die Queue ist **nicht nötig**. *Jede*
  Diskmutation in `index.ts` ist synchron — `fs.writeFileSync` an genau 12 Stellen
  (777, 1553, 1677, 1727, 1768, 1788, 1878, 1929, 1958, 2167, 2239, 2248); `appendFileSync`,
  `writeFile` und `appendFile` kommen **gar nicht** vor; `readFileSafe` ist
  `readFileSync`, `ensureDirs` ist `mkdirSync`. Node ist single-threaded, ein
  Read-Modify-Write ist damit **atomar, solange kein `await` zwischen Lesen und Schreiben
  liegt** — und genau so ist der Code gebaut: erst schreiben, **danach**
  `await ensureQmdAvailableForUpdate()` bzw. `scheduleQmdUpdate()`. Damit existiert die
  befürchtete Verschränkung in-process nicht.
- **Prüfung abgeschlossen (alle 12 Stellen):** Für jede Write-Stelle wurde die
  nächstliegende echte Read-Zeile gegen die nächstliegende `await`-Zeile verglichen
  (gegen `git show HEAD:index.ts`, Muster `/await[ \t(]/`). Achtung: `mawk` versteht kein
  `\b` — ein früherer Lauf mit `\bawait\b` lieferte still falsche „OK"-Ergebnisse.
  Ergebnis: **elf Stellen lückenlos**, eine mit `await` dazwischen — der Recovery-JSON-Write
  in `memory_restore` (Read 2217 → `await` 2243 → Write 2248). Das ist **harmlos**: (a) die
  Strecke 2217→2243 ist rein synchron und damit atomar, (b) ein zweiter Restore derselben ID
  liest `existing` erst *nach* dem ersten Append, `missingEntries` ist dann leer und der
  Inhalts-Append entfällt (genau die zugesagte Idempotenz), (c) es bleibt nur ein zweiter,
  inhaltsgleicher Write des Recovery-JSON. **Regel bleibt:** zwischen Lesen und Schreiben
  niemals `await`en — das gilt auch für jede *neue* Write-Stelle, die der Port hinzufügt.
- **Grenze der Aussage:** Eine In-Process-Queue hätte das eigentliche Restrisiko ohnehin
  nicht gelöst — **zwei OpenCode-Server-Prozesse** auf demselben Speicherordner. Dagegen
  hilft nur, Reads tolerant zu halten.
- **Memory ist global, der Cache ist pro Session:** `memory_forget`/`memory_restore`
  müssen **jede lebende Session** dirty markieren, nicht nur die aufrufende — sonst
  bedienen Geschwister-Sessions weiter veralteten Speicher. Diese Fehlerklasse hatte pi nie.

---

## Offene Punkte

### O1. Compaction-Handoff (relevant wegen opencode-dcp)
`entschieden`

- **Mechanismus:** Mapping von pis `session_before_compact` auf
  **`ctx.session.hook("compaction", …)`**.
- **Es gibt in V2 kein `output.context: string[]`** (das war die V1-Form von
  `experimental.session.compacting`). `SessionCompaction` erweitert `SessionContext` um
  `system`, `messages`, `tools`, `agent`, `model`, `options` und ein optionales
  `result: { summary, providerState?, metadata?, tokens? }`.
- **Umsetzung: `event.system` mutieren** — Handoff-Material als zusätzlichen Text-Part
  anhängen (`event.system = [...event.system, { type: "text", text: HANDOFF }]`):
  fester Header + offene Scratchpad-Items + Tail des heutigen Tagebuchs, mit eigenem Cap.
- **`result` wird nicht gesetzt.** `result.summary` ersetzt die Zusammenfassung komplett
  und überspringt den Model-Request — dann besitzen wir Token-Buchhaltung, Provider-State
  und Summary-Vertrag und werden gegen jede Host-Drift fragil. Wir wollen, dass das Modell
  zusammenfasst, aber angewiesen wird, das Handoff-Material zu bewahren. Genau das leistet
  ein zusätzlicher System-Part.
- **Empirischer Beleg:** dcps `compaction`-Hook existiert ausschließlich, um `event.system`
  und `event.messages` in place umzuschreiben — und läuft. Damit ist belegt, dass
  `system`-Mutation im Compaction-Hook den Compaction-Prompt tatsächlich erreicht.
- **Persistierter Handoff-Block in der Tagesdatei bleibt** (wie pi). Er ist der dauerhafte
  Teil: überlebt Compaction → nächste Session und ist für `memory_read`/`memory_search`
  sichtbar, während die Summary verlustbehaftet ist.
- **Wechselwirkung mit dem byte-stabilen Snapshot:** Der Handoff-Write setzt **nicht** das
  Dirty-Flag. Invariante: ein Handoff-Write darf den **laufenden** Snapshot der Session
  nie invalidieren. Die nächste Session liest die Tagesdatei ohnehin frisch und sieht den
  Block dann.
- **Cap:** eigener Cap für den Handoff-Block, Vorschlag 2,5 K — **beim Port gegen `index.ts`
  verifizieren**, welchen Wert pi real verwendet.
- **dcp-Erkenntnis:** dcp ersetzt obsolete Tool-Outputs nur durch Platzhalter/Summaries
  („session history is never modified“) — kein harter Context-Verlust, daher kein eigener
  Handoff-Trigger nötig. Aber: native opencode-Auto-Kompaktierung (auch bei Overflow mit dcp)
  feuert denselben Hook → unser Handoff greift dort automatisch.

### O2. Snapshot-Refresh bei Deletions/Restores
`entschieden`

- pi refresht den `stable`-Block bei `memory_forget`/`memory_restore`
  (Autoritäts-Operationen) neu.
- **Umsetzung:** Refresh über den `context`-Hook (§5) — er re-injiziert den Speicherblock
  nur, wenn ein Dirty-Flag (Deletion/Restore/Tagwechsel) gesetzt ist; ansonsten byte-stabil
  für den Prefix-Cache.
- **Ort des Flags:** modul-weite Map aus §5, **nicht** im `setup`-Scope (Hooks sind
  per-Request, `setup` läuft einmal pro Plugin-Load).
- Kein Korrektur-Nachrichten-Fallback; der Hook ist der einzige Pfad.
- Dirty-Flag wird von `memory_forget`/`memory_restore` gesetzt — und zwar für **alle**
  lebenden Sessions (§10). Normale Writes (daily/scratchpad) markieren **nicht** dirty
  (pi-`stable`-Semantik).

### O3. UI / Session-Lebenszyklus / Exit-Summary
`entschieden`

- **Modul-Trennung:** opencode hat getrennte Plugin-Entrypoints `server`, `tui`, `rpc`
  (`@opencode/plugin/host`). oc2-memory ist **ausschließlich ein Server-Plugin**.
- **Session-Start:** `for await (const event of ctx.event.subscribe({ signal }))` auf
  `session.created` (alternativ lazy beim ersten `context`-Feuern für die `sessionID`)
  → qmd-Detect/-Setup + Snapshot-Init.
- **Benachrichtigung: gestrichen** (Korrektur zu einer früheren Annahme).
  - Der V2-**Server**-Context hat **kein** `client`, kein `toast`, kein `log`. Die frühere
    Annahme, man könne aus dem Server-Plugin `client.tui.showToast(...)` rufen, ist falsch.
    Nur ein **TUI**-Modul hätte `context.toast.show({ message, variant })` — und ein
    TUI-Modul ist Non-Goal.
  - **Ersatz:** einmal pro Session `console.warn("[oc2-memory] snapshot loaded (<N> bytes) → <pfad>")`
    (genau dcps Degradationspfad; landet im CLI-stderr/dev-Log), plus ein **`memory_status`**,
    der Pfade, qmd, Collection, Embeddings und die aktive Konfiguration berichtet und die
    Doctor-Rolle übernimmt. Einen Snapshot-Modus meldet es nicht mehr — der V2-Hook ist per
    Design immer byte-stabil, `PI_MEMORY_SNAPSHOT` wurde in Phase 4 entfernt.
- **Exit-Summary + Ctrl+D-Erkennung: gestrichen.**
  - Serverseitig existiert **kein** Quit/Shutdown-Event (pis `session_shutdown` fehlt).
    Kandidaten wären `session.idle` (feuert nach *jeder* Runde — falscher Trigger) oder
    TUI-`lifecycle.onDispose` (bräuchte ein zweites TUI-Modul).
  - Nutzen marginal: das Modell schreibt explizit per `memory_write`, O1 deckt den
    Zustand ab, opencode hat eigene Summaries → der LLM-Call auf Verdacht entfällt.
- **Relevante Events:** `session.created`, `session.status`, `session.deleted`,
  `session.compacted`, `session.compaction.*`, `session.error`.
  **`session.idle` ist in 2.0.8 als deprecated markiert** → `session.status` mit
  `status.type: "idle" | "retry" | "busy"` verwenden.

---

## Basis-Dateistruktur (aus pi übernommen)

```
~/.pi/agent/memory/          (bzw. ~/.oc2-memory/ als Fallback)
  MEMORY.md
  SCRATCHPAD.md
  daily/YYYY-MM-DD.md
  recovery/<id>.json
```
