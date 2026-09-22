/**
 * Memory plugin for OpenCode, with qmd-powered search when it is available
 *
 * Plain-Markdown memory system. The core tools (write/read/scratchpad) and
 * memory_search all work without qmd — search falls back to reading the
 * Markdown files directly. qmd adds keyword, semantic and deep search on top.
 *
 * Layout (under ~/.pi/agent/memory/, or ~/.oc2-memory/ when that folder is absent):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *   recovery/*.json        — durable records for restoring memory_forget deletions
 *
 * Tools:
 *   memory_write   — write to MEMORY.md or daily log
 *   memory_forget  — delete matching memory entries and create a recovery record
 *   memory_restore — restore entries from a memory_forget recovery record
 *   memory_read    — read any memory file or list daily logs
 *   scratchpad     — add/check/uncheck/clear items on the scratchpad checklist
 *   memory_search  — search across all memory files via qmd (keyword, semantic, or deep)
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "@opencode/plugin";

// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

type MemoryEnv = Partial<
	Record<"PI_MEMORY_DIR" | "HOME" | "USERPROFILE" | "HOMEDRIVE" | "HOMEPATH", string | undefined>
> & {
	[key: string]: string | undefined;
};

export function resolveHomeDir(env: MemoryEnv): string {
	return (
		env.HOME ??
		env.USERPROFILE ??
		(env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ??
		"~"
	);
}

export function resolveMemoryDir(env: MemoryEnv = process.env): string {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	return path.join(resolveHomeDir(env), ".pi", "agent", "memory");
}

/**
 * Filesystem-aware selector for the memory directory. Memory lives next to an
 * existing pi installation (`~/.pi/agent/memory`) when that folder exists so
 * the two tools share one store; otherwise it falls back to `~/.oc2-memory/`.
 * `PI_MEMORY_DIR` wins and is used unchecked (created on demand).
 *
 * `exists` is injectable so this can be unit-tested without touching the real
 * filesystem. `resolveMemoryDir` stays pure — existence checks live here only.
 */
export function resolveActiveMemoryDir(
	env: MemoryEnv = process.env,
	exists: (p: string) => boolean = fs.existsSync,
): string {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	const piPath = resolveMemoryDir(env);
	if (exists(piPath)) return piPath;
	return path.join(resolveHomeDir(env), ".oc2-memory");
}

// Resolved once per session and cached: a later pi install (or a deletion of
// the pi folder) must not silently move the memory directory mid-session.
let activeMemoryDirCache: string | null = null;

function activeMemoryDir(env: MemoryEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
	if (activeMemoryDirCache === null) activeMemoryDirCache = resolveActiveMemoryDir(env, exists);
	return activeMemoryDirCache;
}

/** Test seam: read the cached active memory dir with an injectable env/exists. */
export function _getActiveMemoryDir(
	env: MemoryEnv = process.env,
	exists: (p: string) => boolean = fs.existsSync,
): string {
	return activeMemoryDir(env, exists);
}

/** Clear the cached memory directory (for testing). */
export function _resetActiveMemoryDir() {
	activeMemoryDirCache = null;
}

let MEMORY_DIR = activeMemoryDir();
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");

/** Override base directory (for testing). */
export function _setBaseDir(baseDir: string) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
	RECOVERY_DIR = path.join(baseDir, "recovery");
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	activeMemoryDirCache = null;
	_setBaseDir(activeMemoryDir());
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(RECOVERY_DIR, { recursive: true });
}

// Daily logs are keyed by the user's LOCAL calendar day. toISOString() is UTC,
// which filed every evening write (after 5pm PDT) under tomorrow's date and
// made the injected "today's log" look at the wrong file.
function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function localDateStr(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayStr(): string {
	return localDateStr(new Date());
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return localDateStr(d);
}

export function nowTimestamp(): string {
	const d = new Date();
	return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDailyDate(date: string): boolean {
	if (!DAILY_DATE_REGEX.test(date)) return false;
	const [year, month, day] = date.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function dailyPath(date: string): string {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
	}
	return path.join(DAILY_DIR, `${date}.md`);
}

// ---------------------------------------------------------------------------
// Limits + preview helpers
// ---------------------------------------------------------------------------

const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
const CONTEXT_MAX_CHARS = 16_000;

type TruncateMode = "start" | "end" | "middle";

interface PreviewResult {
	preview: string;
	truncated: boolean;
	totalLines: number;
	totalChars: number;
	previewLines: number;
	previewChars: number;
}

function normalizeContent(content: string): string {
	return content.trim();
}

function truncateLines(lines: string[], maxLines: number, mode: TruncateMode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}

	if (mode === "end") {
		return { lines: lines.slice(-maxLines), truncated: true };
	}

	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		const head = lines.slice(0, headCount);
		const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
		return { lines: [...head, marker, ...tail], truncated: true };
	}

	return { lines: lines.slice(0, maxLines), truncated: true };
}

function truncateText(text: string, maxChars: number, mode: TruncateMode) {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}

	if (mode === "end") {
		return { text: text.slice(-maxChars), truncated: true };
	}

	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}

	return { text: text.slice(0, maxChars), truncated: true };
}

function buildPreview(
	content: string,
	options: { maxLines: number; maxChars: number; mode: TruncateMode },
): PreviewResult {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return {
			preview: "",
			truncated: false,
			totalLines: 0,
			totalChars: 0,
			previewLines: 0,
			previewChars: 0,
		};
	}

	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;

	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	const text = lineResult.lines.join("\n");
	const charResult = truncateText(text, options.maxChars, options.mode);
	const preview = charResult.text;

	const previewLines = preview ? preview.split("\n").length : 0;
	const previewChars = preview.length;

	return {
		preview,
		truncated: lineResult.truncated || charResult.truncated,
		totalLines,
		totalChars,
		previewLines,
		previewChars,
	};
}

function formatPreviewBlock(label: string, content: string, mode: TruncateMode) {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});

	if (!result.preview) {
		return `${label}: empty.`;
	}

	const meta = `${label} (${result.totalLines} lines, ${result.totalChars} chars)`;
	const note = result.truncated
		? `\n[preview truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${meta}\n\n${result.preview}${note}`;
}

function formatContextSection(label: string, content: string, mode: TruncateMode, maxLines: number, maxChars: number) {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) {
		return "";
	}
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string; // the <!-- timestamp [session] --> comment
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

// Line-preserving mutations. The old parse→mutate→serialize round-trip kept
// only checklist lines, silently deleting anything else in SCRATCHPAD.md
// (hand-written notes, section headers, sub-bullets) on the first write.
// These operate on the raw lines so unknown content survives.

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemoryTarget = "long_term" | "daily";

interface RecoveryRecord {
	version: 1;
	id: string;
	createdAt: string;
	target: MemoryTarget;
	date?: string;
	removedContent: string[];
	restoredAt?: string;
}

export function scratchpadAdd(content: string, text: string, meta: string): string {
	if (!content.trim()) {
		return serializeScratchpad([{ done: false, text, meta }]);
	}
	const base = content.replace(/\n+$/, "");
	return `${base}\n${meta}\n- [ ] ${text}\n`;
}

export function scratchpadToggle(
	content: string,
	needle: string,
	done: boolean,
): { content: string; matched: boolean } {
	const lines = content.split("\n");
	const lower = needle.toLowerCase();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(SCRATCHPAD_ITEM_REGEX);
		if (!m) continue;
		if ((m[1].toLowerCase() === "x") === done) continue;
		if (!m[2].toLowerCase().includes(lower)) continue;
		lines[i] = `- [${done ? "x" : " "}] ${m[2]}`;
		return { content: lines.join("\n"), matched: true };
	}
	return { content, matched: false };
}

export function scratchpadClearDone(content: string): { content: string; removed: number } {
	const lines = content.split("\n");
	const out: string[] = [];
	let removed = 0;
	for (const line of lines) {
		const m = line.match(SCRATCHPAD_ITEM_REGEX);
		if (m && m[1].toLowerCase() === "x") {
			removed++;
			// Drop the item's timestamp comment directly above it, if any.
			if (out.length > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(out[out.length - 1])) {
				out.pop();
			}
			continue;
		}
		out.push(line);
	}
	return { content: out.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// Forget helper — deletion as a first-class operation
// ---------------------------------------------------------------------------

/**
 * Remove every generated entry containing `match` (case-insensitive) from
 * `content`. Generated entries start at a pi-memory timestamp comment and end
 * at the next one, so multi-paragraph writes are removed as a unit. Content
 * before the first generated entry falls back to blank-line paragraph blocks.
 * Returns the surviving content and complete removed entries.
 */
export function forgetBlocks(content: string, match: string): { content: string; removed: string[] } {
	const needle = match.trim().toLowerCase();
	if (!needle) return { content, removed: [] };
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedContent = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");

	const blocks: string[] = [];
	let currentLines: string[] = [];
	let currentIsStamped = false;
	const flushCurrent = () => {
		const current = currentLines.join("\n").trim();
		if (!current) return;
		if (currentIsStamped) {
			blocks.push(current);
		} else {
			blocks.push(
				...current
					.split(/\n{2,}/)
					.map((block) => block.trim())
					.filter(Boolean),
			);
		}
	};

	for (const line of normalizedContent.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
			flushCurrent();
			currentLines = [line];
			currentIsStamped = true;
		} else {
			currentLines.push(line);
		}
	}
	flushCurrent();

	const kept: string[] = [];
	const removed: string[] = [];
	for (const block of blocks) {
		if (block.toLowerCase().includes(needle)) {
			removed.push(block);
		} else {
			kept.push(block);
		}
	}
	if (removed.length === 0) return { content, removed };
	const joined = kept.join("\n\n").trim();
	return {
		content: joined ? `${joined}\n`.replace(/\n/g, newline) : "",
		removed: removed.map((block) => block.replace(/\n/g, newline)),
	};
}

function recoveryPath(recoveryId: string): string | null {
	if (!RECOVERY_ID_REGEX.test(recoveryId)) return null;
	return path.join(RECOVERY_DIR, `${recoveryId}.json`);
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<RecoveryRecord>;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		RECOVERY_ID_REGEX.test(record.id) &&
		(record.target === "long_term" || record.target === "daily") &&
		(record.target !== "daily" || (typeof record.date === "string" && isValidDailyDate(record.date))) &&
		Array.isArray(record.removedContent) &&
		record.removedContent.length > 0 &&
		record.removedContent.every((entry) => typeof entry === "string")
	);
}

function writeRecoveryRecord(target: MemoryTarget, date: string | undefined, removedContent: string[]): RecoveryRecord {
	const record: RecoveryRecord = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		target,
		...(date ? { date } : {}),
		removedContent,
	};
	const filePath = recoveryPath(record.id);
	if (!filePath) throw new Error("Failed to create a valid recovery ID.");
	fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return record;
}

function readRecoveryRecord(recoveryId: string): { record: RecoveryRecord; filePath: string } | null {
	const filePath = recoveryPath(recoveryId);
	if (!filePath) return null;
	const content = readFileSafe(filePath);
	if (!content) return null;
	try {
		const record: unknown = JSON.parse(content);
		if (!isRecoveryRecord(record) || record.id !== recoveryId) return null;
		return { record, filePath };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(searchResults?: string): string {
	ensureDirs();
	// Priority order: scratchpad > today's daily > search results > MEMORY.md > yesterday's daily
	const sections: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;

function isQmdCommand(file: string | URL): boolean {
	if (typeof file !== "string") return false;
	const basename = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "qmd" || basename === "qmd.cmd" || basename === "qmd.exe";
}

const QMD_JS_REL = path.join("node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");

let cachedQmdJsPath: string | null | undefined;

// On Windows, cmd-shim writes the literal `/bin/sh` (the package's shebang
// interpreter) into both qmd.cmd and qmd.ps1, so both shims fail with
// "system cannot find the path specified" / "'/bin/sh.exe' is not recognized"
// outside cygwin/git-bash trees. Bypass the shims by locating qmd's JS entry
// in a sibling node_modules directory of a PATH entry and invoking it with
// node directly — the same thing the sh script in bin/qmd does when launched
// via npm.
export function resolveQmdJsPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (cachedQmdJsPath !== undefined) return cachedQmdJsPath;
	const pathStr = env.PATH ?? env.Path ?? "";
	const entries = pathStr.split(path.delimiter).filter(Boolean);
	for (const dir of entries) {
		try {
			const candidate = path.join(dir, QMD_JS_REL);
			if (fs.statSync(candidate).isFile()) {
				cachedQmdJsPath = candidate;
				return candidate;
			}
		} catch {
			// keep scanning
		}
	}
	cachedQmdJsPath = null;
	return null;
}

/** Clear the resolved qmd.js cache (for testing). */
export function _resetQmdJsResolutionForTest() {
	cachedQmdJsPath = undefined;
}

export function buildQmdSpawn(
	file: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	qmdJsPath: string | null = null,
): { file: string; args: string[] } {
	if (platform !== "win32" || !isQmdCommand(file) || !qmdJsPath) {
		return { file, args: [...args] };
	}
	return { file: "node", args: [qmdJsPath, ...args] };
}

export function buildQmdEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const qmdEnv: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
	delete qmdEnv.FORCE_COLOR;
	return qmdEnv;
}

const execFileWithQmdOptions: ExecFileFn = ((
	file: string,
	args: readonly string[],
	options: ExecFileOptions,
	callback: (...args: any[]) => void,
) => {
	const qmdJs = process.platform === "win32" && isQmdCommand(file) ? resolveQmdJsPath() : null;
	const spawn = buildQmdSpawn(file, args ?? [], process.platform, qmdJs);
	const execOptions = isQmdCommand(file) ? { ...options, env: buildQmdEnv(options.env ?? process.env) } : options;
	return execFile(spawn.file, spawn.args, execOptions, callback as any);
}) as ExecFileFn;

let execFileFn: ExecFileFn = execFileWithQmdOptions;

let qmdAvailable = false;
let qmdAvailabilityCheckedAt = 0;
// Positive results are stable for the session; negative results should refresh
// quickly so users who install qmd (or run setupQmdCollection) mid-session
// don't have to wait through a long TTL before retries succeed.
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
const DEFAULT_QMD_SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_EMBED_PROBE_TIMEOUT_MS = 15_000;
const qmdCollectionStatusCache = new Map<string, { checkedAt: number; exists: boolean }>();

function qmdStatusTtl(positive: boolean): number {
	return positive ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}

export function getQmdSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_QMD_SEARCH_TIMEOUT_MS;
}

export function getEmbedProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_EMBED_PROBE_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_EMBED_PROBE_TIMEOUT_MS;
}
let updateTimer: ReturnType<typeof setTimeout> | null = null;

/** Override execFile implementation (for testing). */
export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}

/** Reset execFile implementation (for testing). */
export function _resetExecFileForTest() {
	execFileFn = execFileWithQmdOptions;
}

/** Set qmd availability flag (for testing). */
export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
	qmdAvailabilityCheckedAt = Date.now();
}

/** Get current qmd availability flag (for testing). */
export function _getQmdAvailable(): boolean {
	return qmdAvailable;
}

/** Get current update timer (for testing). */
export function _getUpdateTimer(): ReturnType<typeof setTimeout> | null {
	return updateTimer;
}

/** Clear the update timer (for testing). */
export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

/** Clear qmd status caches (for testing). */
export function _clearQmdStatusCaches() {
	qmdAvailabilityCheckedAt = 0;
	qmdCollectionStatusCache.clear();
}

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (either works):",
		"  npm install -g @tobilu/qmd        # no Bun needed",
		`  bun install -g ${QMD_REPO_URL}   # ensure ~/.bun/bin is on PATH`,
		"",
		"The plugin auto-creates the collection on next session start.",
		"To set it up manually instead:",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		"qmd collection pi-memory is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the pi-memory collection and path contexts in qmd. */
export async function setupQmdCollection(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", MEMORY_DIR, "--name", "pi-memory"], { timeout: 10_000 }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	} catch {
		// Collection may already exist under a different name — not critical
		return false;
	}

	// Add path contexts (best-effort, ignore errors)
	const contexts: [string, string][] = [
		["/daily", "Daily append-only work logs organized by date"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn("qmd", ["context", "add", ctxPath, desc, "-c", "pi-memory"], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	// Seed the cache so checkCollection("pi-memory") doesn't redundantly re-run
	// setupQmdCollection during the short negative-cache window.
	qmdCollectionStatusCache.set("pi-memory", { checkedAt: Date.now(), exists: true });
	return true;
}

export function detectQmd(): Promise<boolean> {
	const now = Date.now();
	if (qmdAvailabilityCheckedAt && now - qmdAvailabilityCheckedAt < qmdStatusTtl(qmdAvailable)) {
		return Promise.resolve(qmdAvailable);
	}

	return new Promise((resolve) => {
		// `qmd status` can trigger slow model/device probing on some systems (e.g. Vulkan fallback),
		// which may exceed short startup timeouts and produce false negatives.
		// `qmd collection list` is much lighter and still validates the binary is callable.
		execFileFn("qmd", ["collection", "list"], { timeout: 15_000 }, (err) => {
			qmdAvailable = !err;
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

export function checkCollection(name: string): Promise<boolean> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}

	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			let exists = false;
			if (!err) {
				try {
					const collections = JSON.parse(stdout);
					if (Array.isArray(collections)) {
						exists = collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === name;
							}
							return false;
						});
					} else {
						// qmd may output an object with a collections array or similar
						exists = stdout.includes(name);
					}
				} catch {
					// Fallback: just check if the name appears in the output
					exists = stdout.includes(name);
				}
			}
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists });
			resolve(exists);
		});
	});
}

// `qmd embed` is incremental: it only embeds new/changed chunks and no-ops in
// well under a second when everything is current. The first run ever may
// download the embedding model, hence the generous timeout.
const QMD_EMBED_TIMEOUT_MS = 10 * 60 * 1000;
let embedInFlight = false;
let embedPending = false;

/**
 * Ensure a background `qmd embed` is running so semantic/deep search stays
 * usable without the user ever running it manually. Returns true if an embed
 * is now running (started here or already in flight), false if embedding is
 * unavailable (qmd missing or background updates disabled).
 *
 * If an embed is already running, the request is queued: another embed runs
 * immediately after the current one finishes, so chunks written while the
 * first embed was already underway don't have to wait for the next session.
 */
export function ensureQmdEmbed(): boolean {
	if (getQmdUpdateMode() !== "background") return false;
	if (!qmdAvailable) return false;
	if (embedInFlight) {
		embedPending = true;
		return true;
	}
	embedInFlight = true;
	execFileFn("qmd", ["embed"], { timeout: QMD_EMBED_TIMEOUT_MS }, () => {
		embedInFlight = false;
		if (embedPending) {
			embedPending = false;
			ensureQmdEmbed();
		}
	});
	return true;
}

/** Get/clear the embed-in-flight flag (for testing). */
export function _getEmbedInFlight(): boolean {
	return embedInFlight;
}
export function _clearEmbedInFlight() {
	embedInFlight = false;
	embedPending = false;
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => ensureQmdEmbed());
	}, 500);
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 3_000);
			}),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

// The limit reaches `qmd -n` as a CLI argument; NaN/0/negative/huge values
// from a confused model would produce broken qmd invocations.
export function clampSearchLimit(value: number | undefined, fallback = 5, max = 25): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	title?: string;
	[key: string]: unknown;
}

function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

/**
 * Find the line containing the first query term and return it with a line of
 * context either side. Plain string scanning only — no RegExp on user input.
 */
function markdownSnippet(content: string, terms: string[]): string {
	const lines = content.split(/\r?\n/);
	const lowerLines = lines.map((l) => l.toLowerCase());
	const idx = lowerLines.findIndex((l) => terms.some((t) => l.includes(t)));
	if (idx === -1) return content.slice(0, 300).trim();
	const start = Math.max(0, idx - 1);
	const end = Math.min(lines.length, idx + 2);
	return lines.slice(start, end).join("\n").trim();
}

/** Count non-overlapping occurrences of `term` in `haystack` (both lowercase). */
function countOccurrences(haystack: string, term: string): number {
	if (!term) return 0;
	let count = 0;
	let idx = haystack.indexOf(term);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(term, idx + term.length);
	}
	return count;
}

/**
 * Search the markdown memory files directly when qmd is unavailable. Reads
 * MEMORY.md, SCRATCHPAD.md and daily/*.md (newest first); recovery/ holds JSON
 * bookkeeping and is deliberately skipped. All whitespace-separated terms must
 * appear (case-insensitive); results rank by total occurrences. Never throws —
 * an unreadable file is skipped.
 */
export function searchMemoryMarkdown(query: string, limit: number): QmdSearchResult[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0 || limit <= 0) return [];

	// Order breaks ties deterministically: MEMORY.md, then SCRATCHPAD.md, then
	// daily logs newest-first, so a newer daily file wins over an older one.
	const candidates: { path: string; order: number }[] = [
		{ path: MEMORY_FILE, order: 0 },
		{ path: SCRATCHPAD_FILE, order: 1 },
	];

	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.reverse();
	} catch {
		// Missing or unreadable daily directory — nothing to add.
	}
	dailyFiles.forEach((name, i) => {
		candidates.push({ path: path.join(DAILY_DIR, name), order: 2 + i });
	});

	const scored: { result: QmdSearchResult; score: number; order: number }[] = [];
	for (const { path: filePath, order } of candidates) {
		const content = readFileSafe(filePath);
		if (content === null) continue;
		const lower = content.toLowerCase();
		if (!terms.every((t) => lower.includes(t))) continue;

		let score = 0;
		for (const t of terms) score += countOccurrences(lower, t);
		scored.push({
			result: { path: filePath, content: markdownSnippet(content, terms), score },
			score,
			order,
		});
	}

	scored.sort((a, b) => b.score - a.score || a.order - b.order);
	return scored.slice(0, Math.max(0, Math.floor(limit))).map((entry) => entry.result);
}

/** Render search results the same way for both the qmd and markdown paths. */
function formatSearchResults(results: QmdSearchResult[]): string {
	return results
		.map((r, i) => {
			const parts: string[] = [`### Result ${i + 1}`];
			const filePath = getQmdResultPath(r);
			if (filePath) parts.push(`**File:** ${filePath}`);
			if (r.score != null) parts.push(`**Score:** ${r.score}`);
			const text = getQmdResultText(r);
			if (text) parts.push(`\n${text}`);
			return parts.join("\n");
		})
		.join("\n\n---\n\n");
}

/**
 * Graceful degradation for memory_search when qmd is unavailable or its
 * collection cannot be set up: search the markdown files directly instead of
 * erroring. qmd install instructions are kept as a hint at the end.
 */
function markdownFallbackSearch(
	query: string,
	mode: "keyword" | "semantic" | "deep",
	limit: number,
	reason: string,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	const results = searchMemoryMarkdown(query, limit);
	const needsQmdForMode = mode === "semantic" || mode === "deep";
	const header = needsQmdForMode
		? `${reason} — searched the markdown memory files directly. The '${mode}' mode needs qmd; fell back to keyword matching.`
		: `${reason} — searched the markdown memory files directly.`;
	const body = results.length > 0 ? formatSearchResults(results) : `No results found for "${query}".`;
	return {
		content: [{ type: "text", text: [header, "", body, "", qmdInstallInstructions()].join("\n") }],
		details: { mode, query, count: results.length, fallback: "markdown", qmd: false },
	};
}

function stripAnsi(text: string): string {
	// qmd may emit spinners/progress bars even with --json, especially on first model download.
	// Strip ANSI CSI/OSC sequences so we can reliably find and parse JSON payloads.
	// CSI parameter bytes include private-mode sequences such as ESC[?25l / ESC[?25h.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
	timeoutOverrideMs?: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", "pi-memory", "-n", String(limit), query];
	const timeoutMs = timeoutOverrideMs ?? getQmdSearchTimeoutMs();

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				const cleaned = stripAnsi(stderr ?? "").trim();
				const cleanedMessage = stripAnsi(err.message).trim();
				const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
				const hint = timedOut
					? ` (qmd timed out after ${timeoutMs / 1000}s — first semantic/deep search may download or load models; retry shortly)`
					: "";
				reject(new Error(`${cleaned || cleanedMessage}${hint}`));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : ((parsed as any).results ?? (parsed as any).hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

/**
 * Best-effort check of whether vector embeddings are ready for semantic/deep
 * search. Bounded by a timeout because the first semantic query can trigger a
 * model download. Returns "unknown" rather than blocking on it.
 * "ready" means a probe query ran without qmd's "need embeddings" warning —
 * it does not prove the index has content.
 *
 * The bound must stay well clear of normal `qmd vsearch` latency: the probe
 * runs an embed + rerank pass (measured ~2.4-3.6s idle, >4s while a background
 * re-index competes for CPU and the embedding model). A tighter bound made
 * `memory_status` report "unknown" immediately after a write, which is exactly
 * when the index is busy. Override with PI_MEMORY_EMBED_PROBE_TIMEOUT_MS.
 */
export async function probeEmbeddings(): Promise<"ready" | "missing" | "unknown"> {
	const probeTimeoutMs = getEmbedProbeTimeoutMs();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { stderr } = await Promise.race([
			// Bound the child by the same budget so a probe we abandon does not
			// leave a long-running LLM query behind.
			runQmdSearch("semantic", "memory", 1, probeTimeoutMs),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), probeTimeoutMs);
			}),
		]);
		return /need embeddings/i.test(stderr ?? "") ? "missing" : "ready";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/need embeddings/i.test(msg)) return "missing";
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

/** Collect a fast on-disk inventory of the memory files (no qmd needed). */
export function getMemoryInventory(): {
	dir: string;
	longTermChars: number;
	scratchpadOpen: number;
	scratchpadTotal: number;
	dailyCount: number;
	latestDaily: string | null;
} {
	const longTerm = readFileSafe(MEMORY_FILE) ?? "";
	const scratchpad = readFileSafe(SCRATCHPAD_FILE) ?? "";
	const items = parseScratchpad(scratchpad);
	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	return {
		dir: MEMORY_DIR,
		longTermChars: longTerm.trim().length,
		scratchpadOpen: items.filter((i) => !i.done).length,
		scratchpadTotal: items.length,
		dailyCount: dailyFiles.length,
		latestDaily: dailyFiles.length ? dailyFiles[dailyFiles.length - 1].replace(/\.md$/, "") : null,
	};
}

// ---------------------------------------------------------------------------
// Memory snapshot (Option P: KV cache-stable context injection)
//
// The system prompt must be byte-stable across turns so local prefix caches
// (llama.cpp, vLLM, MLX) don't invalidate the entire conversation tail on each
// turn. We snapshot the memory context at deliberate checkpoints
// (session_start, session_before_compact, long_term writes, day rollover) and
// emit the same bytes for every turn in between.
// ---------------------------------------------------------------------------

/**
 * Snapshot mode configuration (PI_MEMORY_SNAPSHOT). Kept for Phase 4 — the V2
 * snapshot cache that consumes it lives further down.
 */
function getSnapshotMode(): "stable" | "refresh" | "per-turn" {
	const mode = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").toLowerCase();
	if (mode === "per-turn") return "per-turn";
	if (mode === "refresh") return "refresh";
	return "stable";
}

// ---------------------------------------------------------------------------
// Memory tools
//
// The seven definitions are OpenCode-agnostic: each keeps an internal
// execute(params, ctx) returning the internal `{ content, isError?, details }`
// shape, so the bodies stay free of any host framework and remain directly
// testable. `toOpenCodeTool` adapts them to the V2 Tool.Result boundary only at
// registration time.
// ---------------------------------------------------------------------------

interface MemoryToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
	details: Record<string, unknown>;
}

interface MemoryToolContext {
	sessionManager: { getSessionId(): string };
}

interface MemoryToolInput {
	type: "object";
	properties: Record<string, unknown>;
	required: string[];
	additionalProperties: false;
}

interface MemoryToolDefinition {
	name: string;
	description: string;
	input: MemoryToolInput;
	execute: (params: any, ctx: MemoryToolContext) => Promise<MemoryToolResult>;
}

export const MEMORY_TOOLS: MemoryToolDefinition[] = [
	{
		name: "memory_write",
		description: [
			"Write to memory files. Two targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
			"Use #tags (e.g. #decision, #preference, #lesson, #bug) and [[links]] (e.g. [[auth-strategy]]) in content to improve searchability.",
		].join("\n"),
		input: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["long_term", "daily"],
					description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log",
				},
				content: { type: "string", description: "Content to write (Markdown)" },
				mode: {
					type: "string",
					enum: ["append", "overwrite"],
					description: "Write mode for long_term target. Default: 'append'. Daily always appends.",
				},
			},
			required: ["target", "content"],
			additionalProperties: false,
		},
		async execute(params, ctx) {
			ensureDirs();
			const { target, content, mode } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "end",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Appended to daily log: ${filePath}${existingSnippet}`,
						},
					],
					details: {
						path: filePath,
						target,
						mode: "append",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// long_term
			const existing = readFileSafe(MEMORY_FILE) ?? "";
			const existingPreview = buildPreview(existing, {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "middle",
			});
			const existingSnippet = existingPreview.preview
				? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
				: "\n\nMEMORY.md was empty.";

			// Long-term writes change the ambient "background context" the model
			// should always see. Mark session snapshots dirty so the next turn
			// refreshes. Daily writes are high-frequency and already echoed via
			// tool-call args — they are intentionally NOT marked dirty.
			markAllSessionsDirty();

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(MEMORY_FILE, stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: {
						path: MEMORY_FILE,
						target,
						mode: "overwrite",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// append (default)
			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			fs.writeFileSync(MEMORY_FILE, existing + separator + stamped, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: {
					path: MEMORY_FILE,
					target,
					mode: "append",
					sessionId: sid,
					timestamp: ts,
					qmdUpdateMode: getQmdUpdateMode(),
					existingPreview,
				},
			};
		},
	},
	{
		name: "scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		input: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["add", "done", "undo", "clear_done", "list"],
					description: "What to do",
				},
				text: {
					type: "string",
					description: "Item text for add, or substring to match for done/undo",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
		async execute(params, ctx) {
			ensureDirs();
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			const items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: "Scratchpad is empty." }],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				return {
					content: [
						{
							type: "text",
							text: formatPreviewBlock("Scratchpad preview", serialized, "start"),
						},
					],
					details: {
						count: items.length,
						open: items.filter((i) => !i.done).length,
						preview,
					},
				};
			}

			if (action === "add") {
				if (!text) {
					return {
						content: [{ type: "text", text: "Error: 'text' is required for add." }],
						details: {},
					};
				}
				const serialized = scratchpadAdd(existing, text, `<!-- ${ts} [${sid}] -->`);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return {
						content: [
							{
								type: "text",
								text: `Error: 'text' is required for ${action}.`,
							},
						],
						details: {},
					};
				}
				const targetDone = action === "done";
				const toggled = scratchpadToggle(existing, text, targetDone);
				if (!toggled.matched) {
					return {
						content: [
							{
								type: "text",
								text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"`,
							},
						],
						details: {},
					};
				}
				const serialized = toggled.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "clear_done") {
				const cleared = scratchpadClearDone(existing);
				const removed = cleared.removed;
				const serialized = cleared.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						removed,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
			};
		},
	},
	{
		name: "memory_read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'list': List all daily log files.",
		].join("\n"),
		input: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["long_term", "scratchpad", "daily", "list"],
					description: "What to read",
				},
				date: {
					type: "string",
					description: "Date for daily log (YYYY-MM-DD). Default: today.",
				},
			},
			required: ["target"],
			additionalProperties: false,
		},
		async execute(params, _ctx) {
			ensureDirs();
			const { target, date } = params;

			if (target === "list") {
				try {
					const files = fs
						.readdirSync(DAILY_DIR)
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
					if (files.length === 0) {
						return {
							content: [{ type: "text", text: "No daily logs found." }],
							details: {},
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`,
							},
						],
						details: { files },
					};
				} catch {
					return {
						content: [{ type: "text", text: "No daily logs directory." }],
						details: {},
					};
				}
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }],
						isError: true,
						details: { date: d },
					};
				}
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) {
					return {
						content: [{ type: "text", text: `No daily log for ${d}.` }],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: filePath, date: d },
				};
			}

			if (target === "scratchpad") {
				const content = readFileSafe(SCRATCHPAD_FILE);
				if (!content?.trim()) {
					return {
						content: [
							{
								type: "text",
								text: "SCRATCHPAD.md is empty or does not exist.",
							},
						],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: SCRATCHPAD_FILE },
				};
			}

			// long_term
			const content = readFileSafe(MEMORY_FILE);
			if (!content) {
				return {
					content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: content }],
				details: { path: MEMORY_FILE },
			};
		},
	},
	{
		name: "memory_forget",
		description: [
			"Delete outdated or incorrect facts from memory. Removes every entry/paragraph",
			"containing the match string (case-insensitive substring) from MEMORY.md, or from",
			"a daily log when target='daily'. Every deletion creates a durable recovery record",
			"whose visible recovery ID can be passed to memory_restore if the deletion was wrong.",
			"Use this when the user corrects a stored fact or a memory is no longer true —",
			"stale entries keep resurfacing in retrieval and cause confidently wrong answers.",
		].join("\n"),
		input: {
			type: "object",
			properties: {
				match: {
					type: "string",
					description: "Case-insensitive substring identifying the fact(s) to remove",
				},
				target: {
					type: "string",
					enum: ["long_term", "daily"],
					description: "Where to delete from: 'long_term' (MEMORY.md, default) or 'daily'",
				},
				date: {
					type: "string",
					description: "Daily log date (YYYY-MM-DD) when target='daily'. Default: today.",
				},
			},
			required: ["match"],
			additionalProperties: false,
		},
		async execute(params, _ctx) {
			ensureDirs();
			const target: MemoryTarget = params.target ?? "long_term";
			if (!params.match.trim()) {
				return {
					content: [{ type: "text", text: "Error: 'match' must not be empty." }],
					isError: true,
					details: {},
				};
			}
			let filePath: string;
			let recoveryDate: string | undefined;
			if (target === "daily") {
				const d = params.date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }],
						isError: true,
						details: { date: d },
					};
				}
				filePath = dailyPath(d);
				recoveryDate = d;
			} else {
				filePath = MEMORY_FILE;
			}

			const existing = readFileSafe(filePath);
			if (!existing?.trim()) {
				return {
					content: [{ type: "text", text: `Nothing stored in ${filePath} — nothing to forget.` }],
					details: { path: filePath, removed: 0 },
				};
			}

			const result = forgetBlocks(existing, params.match);
			if (result.removed.length === 0) {
				return {
					content: [{ type: "text", text: `No entries matching "${params.match}" in ${filePath}.` }],
					details: { path: filePath, removed: 0 },
				};
			}

			// Persist the complete recovery payload before mutating the source file.
			// If either write fails, we never report a successful unrecoverable deletion.
			const recovery = writeRecoveryRecord(target, recoveryDate, result.removed);
			fs.writeFileSync(filePath, result.content, "utf-8");
			// Forget is a privacy-sensitive mutation. Invalidate every live session's
			// snapshot so deleted content disappears from authoritative context.
			markAllSessionsDirty();
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();

			const removedPreview = buildPreview(result.removed.join("\n\n"), {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "start",
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Removed ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} from ${filePath}. ` +
							`Recovery ID: ${recovery.id}. To undo this deletion, call memory_restore with that ID.\n\n` +
							"Removed content preview:\n\n" +
							removedPreview.preview,
					},
				],
				details: {
					path: filePath,
					target,
					removed: result.removed.length,
					recoveryId: recovery.id,
					recoveryPath: recoveryPath(recovery.id),
					removedPreview,
				},
			};
		},
	},
	{
		name: "memory_restore",
		description: [
			"Restore entries removed by memory_forget using the recovery ID returned by that tool.",
			"Restoration is idempotent and appends only missing entries, so later memory writes survive.",
		].join("\n"),
		input: {
			type: "object",
			properties: {
				recoveryId: { type: "string", description: "Recovery ID returned by memory_forget" },
			},
			required: ["recoveryId"],
			additionalProperties: false,
		},
		async execute(params, _ctx) {
			ensureDirs();
			const loaded = readRecoveryRecord(params.recoveryId);
			if (!loaded) {
				return {
					content: [{ type: "text", text: `No valid recovery record found for ID ${params.recoveryId}.` }],
					isError: true,
					details: { recoveryId: params.recoveryId },
				};
			}

			const { record, filePath: recordPath } = loaded;
			if (record.restoredAt) {
				return {
					content: [{ type: "text", text: `Recovery ${record.id} was already restored at ${record.restoredAt}.` }],
					details: { recoveryId: record.id, restoredAt: record.restoredAt },
				};
			}

			const targetPath = record.target === "daily" ? dailyPath(record.date as string) : MEMORY_FILE;
			const existing = readFileSafe(targetPath) ?? "";
			const missingEntries = record.removedContent.filter((entry) => !existing.includes(entry));
			if (missingEntries.length > 0) {
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(targetPath, `${existing}${separator}${missingEntries.join("\n\n")}\n`, "utf-8");
				// Restore changes which durable facts are authoritative, so invalidate
				// every live session's snapshot.
				markAllSessionsDirty();
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
			}

			record.restoredAt = new Date().toISOString();
			fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
			return {
				content: [
					{
						type: "text",
						text:
							missingEntries.length > 0
								? `Restored ${missingEntries.length} entr${missingEntries.length === 1 ? "y" : "ies"} to ${targetPath}.`
								: `Recovery ${record.id} was already present in ${targetPath}; marked as restored.`,
					},
				],
				details: {
					recoveryId: record.id,
					target: record.target,
					path: targetPath,
					restored: missingEntries.length,
				},
			};
		},
	},
	{
		name: "memory_search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid search with reranking. Use when other modes don't find what you need.\n" +
			"If semantic/deep warns about missing embeddings, embedding starts automatically in the background — retry shortly.\n" +
			"If the first search doesn't find what you need, try rephrasing or switching modes. " +
			"Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.",
		input: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				mode: {
					type: "string",
					enum: ["keyword", "semantic", "deep"],
					description: "Search mode. Default: 'keyword'.",
				},
				limit: { type: "number", description: "Max results (default: 5)" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		async execute(params, _ctx) {
			const mode = params.mode ?? "keyword";
			const limit = clampSearchLimit(params.limit);

			if (!qmdAvailable) {
				// Re-check on demand in case qmd was installed after session start.
				qmdAvailable = await detectQmd();
			}

			if (!qmdAvailable) {
				return markdownFallbackSearch(params.query, mode, limit, "qmd is not installed");
			}

			let hasCollection = await checkCollection("pi-memory");
			if (!hasCollection) {
				const created = await setupQmdCollection();
				if (created) {
					hasCollection = true;
				}
			}
			if (!hasCollection) {
				return markdownFallbackSearch(params.query, mode, limit, "Could not set up the qmd pi-memory collection");
			}

			try {
				const { results, stderr } = await runQmdSearch(mode, params.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				// Self-heal: any "need embeddings" warning (even with partial
				// results) kicks off an incremental background embed.
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;

				if (results.length === 0) {
					if (needsEmbed && (mode === "semantic" || mode === "deep")) {
						return {
							content: [
								{
									type: "text",
									text: [
										`No results found for "${params.query}" (mode: ${mode}).`,
										"",
										"qmd reports missing vector embeddings for one or more documents.",
										...(embedStarted
											? [
													"Embedding has been started in the background — retry the search shortly.",
													"(The very first embed may take longer while the embedding model downloads.)",
												]
											: ["Run this once, then retry:", "  qmd embed"]),
									].join("\n"),
								},
							],
							details: { mode, query: params.query, count: 0, needsEmbed: true, embedStarted },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${params.query}" (mode: ${mode}).`,
							},
						],
						details: { mode, query: params.query, count: 0, needsEmbed },
					};
				}

				const formatted = formatSearchResults(results);

				return {
					content: [{ type: "text", text: formatted }],
					details: { mode, query: params.query, count: results.length, needsEmbed },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `memory_search error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	},
	{
		name: "memory_status",
		description:
			"Report the health of the memory system: where files live, what's stored, " +
			"whether qmd search is available, whether the pi-memory collection exists, " +
			"whether embeddings are ready, and the active configuration. " +
			"Use this when search behaves unexpectedly or to confirm setup.",
		input: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
		async execute(_params, _ctx) {
			ensureDirs();
			const inv = getMemoryInventory();

			const qmdOk = qmdAvailable || (await detectQmd());
			let collectionOk = false;
			let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
			if (qmdOk) {
				collectionOk = await checkCollection("pi-memory");
				embeddings = collectionOk ? await probeEmbeddings() : "n/a";
			}

			const mark = (ok: boolean) => (ok ? "✓" : "✗");
			const lines: string[] = [
				"# Memory status",
				"",
				`- Memory dir: ${inv.dir}`,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Scratchpad: ${inv.scratchpadOpen} open / ${inv.scratchpadTotal} total`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
				"",
				"## Search (qmd)",
				`- qmd available: ${mark(qmdOk)}`,
			];

			if (qmdOk) {
				lines.push(`- Collection \`pi-memory\`: ${mark(collectionOk)}`);
				if (collectionOk) {
					const embMark = embeddings === "ready" ? "✓" : embeddings === "missing" ? "⚠" : "?";
					lines.push(`- Embeddings (semantic/deep): ${embMark} ${embeddings}`);
					if (embeddings === "missing") {
						if (ensureQmdEmbed()) {
							lines.push("  - Embedding started in the background — re-run memory_status to confirm.");
						} else {
							lines.push("  - Run `qmd embed` once to enable semantic/deep search.");
						}
					} else if (embeddings === "unknown") {
						lines.push(
							`  - Could not verify within the ${getEmbedProbeTimeoutMs() / 1000}s probe timeout; run a semantic search to confirm.`,
							"  - A background re-index can slow the probe. Raise PI_MEMORY_EMBED_PROBE_TIMEOUT_MS if it persists.",
						);
					}
				} else {
					lines.push("  - Run a `memory_search` (auto-creates it) or `qmd collection add` manually.");
				}
			} else {
				lines.push("", qmdInstallInstructions());
			}

			lines.push(
				"",
				"## Configuration",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: ${getQmdSearchTimeoutMs()}`,
				`- PI_MEMORY_EMBED_PROBE_TIMEOUT_MS: ${getEmbedProbeTimeoutMs()}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? "set" : "default"}`,
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					...inv,
					qmd: qmdOk,
					collection: collectionOk,
					embeddings,
					snapshotMode: getSnapshotMode(),
					qmdUpdateMode: getQmdUpdateMode(),
				},
			};
		},
	},
];

// Derived from the plugin SDK so the mapping stays honest across SDK upgrades.
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];
type OpenCodeTool = Parameters<ToolEditor["add"]>[0];

/**
 * Adapt an internal definition to the V2 boundary. V2's Tool.Result accepts
 * `content?: string | ReadonlyArray<Content>` plus `metadata`; the internal
 * `isError` flag is signalled by rejecting, which the promise adapter turns into
 * a tool error.
 */
function toOpenCodeTool(def: MemoryToolDefinition): OpenCodeTool {
	return {
		name: def.name,
		description: def.description,
		input: def.input as unknown as OpenCodeTool["input"],
		execute: async (input, context) => {
			const result = await def.execute(input, {
				sessionManager: { getSessionId: () => context.sessionID },
			});
			const text = result.content.map((part) => part.text).join("\n\n");
			if (result.isError) throw new Error(text);
			return { content: text, metadata: result.details };
		},
	};
}

// ---------------------------------------------------------------------------
// OpenCode V2 plugin entry point
//
// OpenCode loads a plugin file only when its default export is `{ id, setup }`.
// Registers the memory tools, the context/compaction hooks and the event
// subscription. There is no pi coupling in this file.
// ---------------------------------------------------------------------------

const SNAPSHOT_SENTINEL = "<!-- oc2-memory:snapshot -->";
const HANDOFF_SENTINEL = "<!-- oc2-memory:handoff -->";
const HANDOFF_MAX_LINES = 40;
const HANDOFF_MAX_CHARS = 4_000;

type SnapshottedPart = { type: "text"; text: string };

interface SessionSnapshot {
	block: string;
	dayKey: string;
	dirty: boolean;
}

// The memory store is global, so a long-term write has to invalidate every
// live session's block; the block itself is cached per session.
const sessionSnapshots = new Map<string, SessionSnapshot>();
const warnedSessions = new Set<string>();

/** Mark every live session's snapshot stale (long-term writes, forget, restore). */
export function markAllSessionsDirty() {
	for (const entry of sessionSnapshots.values()) entry.dirty = true;
}

/**
 * Replace the system part carrying the snapshot sentinel in place, or append a
 * new one. The V2 context hook fires on every request, so without the sentinel
 * lookup each turn would append another copy of the block.
 */
export function upsertSnapshotPart<T extends SnapshottedPart>(system: readonly T[], block: string): T[] {
	const index = system.findIndex((part) => part.type === "text" && part.text.includes(SNAPSHOT_SENTINEL));
	if (index === -1) {
		return [...system, { type: "text", text: block } as T];
	}
	return system.map((part, i) => (i === index ? { ...part, text: block } : part));
}

/**
 * Resolve the block for one session, rebuilding only when the cached copy was
 * invalidated or the calendar day rolled over.
 */
function getSessionSnapshot(sessionID: string): string {
	const today = todayStr();
	const cached = sessionSnapshots.get(sessionID);
	if (!cached || cached.dirty || cached.dayKey !== today) {
		const firstBuild = !cached;
		const block = `${SNAPSHOT_SENTINEL}\n${buildMemoryContext("")}`;
		sessionSnapshots.set(sessionID, { block, dayKey: today, dirty: false });
		if (firstBuild) {
			// No toast exists in the V2 server context; a warning is the only channel.
			console.warn(`[oc2-memory] snapshot built (${Buffer.byteLength(block, "utf-8")} bytes) from ${MEMORY_DIR}`);
		}
	}
	return sessionSnapshots.get(sessionID)?.block ?? "";
}

/**
 * Build the compaction handoff section: open scratchpad items plus the tail of
 * today's daily log, capped by the shared section formatter.
 */
function buildHandoffSection(): string {
	const parts: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((item) => !item.done);
		if (openItems.length > 0) {
			parts.push("**Open scratchpad items:**", serializeScratchpad(openItems).trimEnd());
		}
	}

	const todayContent = readFileSafe(dailyPath(todayStr()));
	if (todayContent?.trim()) {
		const { lines } = truncateLines(todayContent.trim().split("\n"), HANDOFF_MAX_LINES, "end");
		parts.push("**Recent daily log context:**", lines.join("\n"));
	}

	if (parts.length === 0) return "";
	return formatContextSection("## Session Handoff", parts.join("\n\n"), "end", HANDOFF_MAX_LINES, HANDOFF_MAX_CHARS);
}

/** Append the handoff block to today's daily log so it survives the session. */
function appendHandoffToDaily(block: string) {
	ensureDirs();
	const filePath = dailyPath(todayStr());
	const existing = readFileSafe(filePath) ?? "";
	const separator = existing.trim() ? "\n\n" : "";
	fs.writeFileSync(filePath, existing + separator + block, "utf-8");
}

/** session.created: detect qmd, best-effort collection setup, warn once per session. */
async function handleSessionCreated(sessionID: string) {
	qmdAvailable = await detectQmd();
	if (qmdAvailable) {
		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) await setupQmdCollection();
	}
	if (!warnedSessions.has(sessionID)) {
		warnedSessions.add(sessionID);
		console.warn(`[oc2-memory] session ${sessionID}: qmd ${qmdAvailable ? "ready" : "unavailable"}`);
	}
}

/**
 * OpenCode V2 entry point. Registers the context/compaction hooks and starts
 * the event subscription; returns a cleanup that clears the per-session cache
 * and stops the subscription.
 */
export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
	const controller = new AbortController();

	await ctx.tool.transform((editor) => {
		for (const tool of MEMORY_TOOLS) {
			editor.add(toOpenCodeTool(tool));
		}
	});

	await ctx.session.hook("context", (event) => {
		event.system = upsertSnapshotPart(event.system, getSessionSnapshot(event.sessionID));
	});

	await ctx.session.hook("compaction", (event) => {
		const section = buildHandoffSection();
		if (!section) return;
		const block = `${HANDOFF_SENTINEL}\n${section}`;
		event.system = [...event.system, { type: "text", text: block }];
		// Survives the session and stays searchable — but does not invalidate the
		// snapshot: the handoff is a separate part, not the memory block.
		appendHandoffToDaily(block);
	});

	const subscription = (async () => {
		try {
			for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
				if (event.type === "session.created") {
					await handleSessionCreated(event.data.sessionID);
				}
			}
		} catch {
			// The stream closed or was aborted; cleanup owns the lifecycle.
		}
	})();

	return async () => {
		controller.abort();
		sessionSnapshots.clear();
		warnedSessions.clear();
		await subscription.catch(() => {});
	};
}

export default { id: "oc2-memory", setup } satisfies Plugin.Plugin;
