/**
 * Unit tests for pi-memory extension.
 *
 * Run:   bun test test/unit.test.ts
 *
 * Uses temp directories for all file I/O — does not touch real memory files.
 */

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_clearEmbedInFlight,
	_clearUpdateTimer,
	_getActiveMemoryDir,
	_getEmbedInFlight,
	_getUpdateTimer,
	_resetActiveMemoryDir,
	_resetBaseDir,
	_resetExecFileForTest,
	_resetQmdJsResolutionForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	buildMemoryContext,
	buildQmdEnv,
	buildQmdSpawn,
	clampSearchLimit,
	dailyPath,
	ensureDirs,
	ensureQmdEmbed,
	forgetBlocks,
	getEmbedProbeTimeoutMs,
	getQmdSearchTimeoutMs,
	MEMORY_TOOLS,
	nowTimestamp,
	parseScratchpad,
	probeEmbeddings,
	qmdCollectionInstructions,
	qmdInstallInstructions,
	readFileSafe,
	resolveActiveMemoryDir,
	resolveHomeDir,
	resolveMemoryDir,
	resolveQmdJsPath,
	runQmdSearch,
	type ScratchpadItem,
	scheduleQmdUpdate,
	scratchpadAdd,
	scratchpadClearDone,
	scratchpadToggle,
	searchMemoryMarkdown,
	serializeScratchpad,
	shortSessionId,
	todayStr,
	yesterdayStr,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
	_setBaseDir(tmpDir);
}

function cleanupTmpDir() {
	_resetBaseDir();
	_setQmdAvailable(false);
	_clearUpdateTimer();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Build the tool map from the exported OpenCode-agnostic definitions. */
function memoryTools(): Record<string, any> {
	const tools: Record<string, any> = {};
	for (const tool of MEMORY_TOOLS) {
		tools[tool.name] = {
			...tool,
			// Tests keep calling the old 5-arg shape; adapt to execute(params, ctx).
			execute: (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => tool.execute(params, ctx),
		};
	}
	return tools;
}

/** Create a mock tool execution context. */
function createMockCtx(sessionId = "abcdef1234567890") {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
		},
		hasUI: true,
		ui: {
			notify: mock(() => {}),
		},
	};
}

describe("runtime package scope", () => {
	test("declares the oc2-memory identity", () => {
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
		const agentsGuide = fs.readFileSync(new URL("../AGENTS.md", import.meta.url), "utf-8");

		expect(packageJson.name).toBe("oc2-memory");
		expect(packageJson.type).toBe("module");
		expect(packageJson.author).toBe("swapdte");
		expect(packageJson.license).toBe("MIT");

		// OpenCode resolves a plugin's entrypoints as module paths, so main/exports must point at
		// the built artefact rather than at the TypeScript source.
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports?.["."]).toBe("./dist/index.js");
		expect(packageJson.exports?.["./server"]).toBe("./dist/index.js");
		expect(packageJson.files).toContain("dist");

		// Neither runtime has a manifest field for plugins: pi's was "pi", OpenCode has none.
		expect(packageJson.pi).toBeUndefined();
		expect(packageJson.opencode).toBeUndefined();

		expect(packageJson.devDependencies["@opencode/plugin"]).toBe("2.0.2");
		expect(packageJson.devDependencies.tsup).toBeDefined();
		expect(packageJson.engines.node).toBe(">=22.19.0");

		// The port is documented, and the docs name the upstream it was forked from.
		expect(agentsGuide).toContain("https://github.com/jayzeng/pi-memory");
	});

	// The port is finished: no pi packages remain in the runtime source or the
	// manifest, and the deprecated @mariozechner fork must not creep back in.
	test("has no pi coupling", () => {
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
		const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

		expect(source).not.toContain("@earendil-works");
		expect(source).not.toContain("@mariozechner");

		expect(packageJson.devDependencies["@earendil-works/pi-ai"]).toBeUndefined();
		expect(packageJson.devDependencies["@earendil-works/pi-coding-agent"]).toBeUndefined();
		expect(packageJson.peerDependencies?.["@earendil-works/pi-ai"]).toBeUndefined();
		expect(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
		expect(packageJson.peerDependencies?.["@sinclair/typebox"]).toBeUndefined();
	});
});

describe("GitHub Actions workflows", () => {
	const ciWorkflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf-8");
	const e2eWorkflow = fs.readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf-8");
	const publishWorkflow = fs.readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf-8");
	const qmdWorkflow = fs.readFileSync(new URL("../.github/workflows/windows-qmd-smoke.yml", import.meta.url), "utf-8");

	test("runs feature-branch CI once and cancels superseded runs", () => {
		expect(ciWorkflow).toContain("push:\n    branches: [main]\n  pull_request:");
		expect(ciWorkflow).toContain(
			`group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}`,
		);
		expect(ciWorkflow).toContain("cancel-in-progress: true");
	});

	test("installs once per OS for the fast verification path", () => {
		expect(ciWorkflow.match(/- run: npm ci/g)).toHaveLength(2);
		expect(ciWorkflow).toContain("name: verify (ubuntu-latest)");
		expect(ciWorkflow).toContain("name: unit (windows-latest)");
		expect(ciWorkflow).not.toContain("matrix:");
		expect(ciWorkflow).not.toContain("windows-qmd-smoke");
		expect(ciWorkflow).not.toContain("OPENAI_API_KEY");
	});

	test("pins and caches the path-filtered Windows qmd smoke", () => {
		expect(qmdWorkflow).toContain("name: Windows qmd smoke");
		expect(qmdWorkflow).toContain("paths:");
		expect(qmdWorkflow).toContain('QMD_VERSION: "2.5.3"');
		expect(qmdWorkflow).toContain("uses: actions/cache@v5");
		expect(qmdWorkflow).toContain('"@tobilu/qmd@$env:QMD_VERSION"');
	});

	test("keeps API-backed e2e explicit and uses the e2e command", () => {
		expect(e2eWorkflow).toContain("workflow_dispatch:");
		expect(e2eWorkflow).not.toContain("pull_request:");
		expect(e2eWorkflow).toContain("run: npm run test:e2e");
	});

	test("publishes matching release tags on the supported Node runtime with provenance", () => {
		expect(publishWorkflow).toContain('tags:\n      - "v*"');
		expect(publishWorkflow).toContain(`NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`);
		expect(publishWorkflow).toContain('node-version: "22.19.0"');
		expect(publishWorkflow).toContain("id-token: write");
		expect(publishWorkflow).toContain(`tag="\${GITHUB_REF_NAME#v}"`);
		expect(publishWorkflow).toContain("npm run lint");
		expect(publishWorkflow).toContain("npm run build");
		expect(publishWorkflow).toContain("npm test");
		expect(publishWorkflow).toContain("npm publish --provenance");
	});
});

// We need to import the extension registration and V2 setup entry points
import oc2MemoryPlugin, { setup } from "../index.js";

// ==========================================================================
// 1. Utility functions
// ==========================================================================

describe("todayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		const result = todayStr();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns a 10-character string", () => {
		expect(todayStr()).toHaveLength(10);
	});
});

describe("yesterdayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		const result = yesterdayStr();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns a date before today", () => {
		const today = new Date(todayStr());
		const yesterday = new Date(yesterdayStr());
		expect(yesterday.getTime()).toBeLessThan(today.getTime());
	});
});

describe("nowTimestamp", () => {
	test("returns timestamp in YYYY-MM-DD HH:MM:SS format", () => {
		const result = nowTimestamp();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	test("does not contain T or Z", () => {
		const result = nowTimestamp();
		expect(result).not.toContain("T");
		expect(result).not.toContain("Z");
	});
});

describe("resolveMemoryDir", () => {
	test("prefers PI_MEMORY_DIR", () => {
		const env = {
			PI_MEMORY_DIR: path.join("custom", "memory"),
			HOME: path.join("home", "ignored"),
			USERPROFILE: path.join("profile", "ignored"),
		};

		expect(resolveMemoryDir(env)).toBe(env.PI_MEMORY_DIR);
	});

	test("falls back to USERPROFILE when HOME is unset", () => {
		const env = {
			USERPROFILE: path.join("Users", "runneradmin"),
		};

		expect(resolveMemoryDir(env)).toBe(path.join(env.USERPROFILE, ".pi", "agent", "memory"));
	});
});

describe("resolveHomeDir", () => {
	test("prefers HOME over the other home variables", () => {
		const env = {
			HOME: path.join("home", "user"),
			USERPROFILE: path.join("Users", "other"),
			HOMEDRIVE: "C:",
			HOMEPATH: "\\Users\\drive",
		};

		expect(resolveHomeDir(env)).toBe(env.HOME);
	});

	test("joins HOMEDRIVE and HOMEPATH when HOME and USERPROFILE are unset", () => {
		const env = { HOMEDRIVE: "C:", HOMEPATH: "\\Users\\drive" };

		expect(resolveHomeDir(env)).toBe("C:\\Users\\drive");
	});

	test("falls back to the literal ~ when nothing is set", () => {
		expect(resolveHomeDir({})).toBe("~");
	});
});

describe("resolveActiveMemoryDir", () => {
	afterEach(() => {
		_resetActiveMemoryDir();
	});

	test("prefers PI_MEMORY_DIR even when the pi folder exists", () => {
		const env = {
			PI_MEMORY_DIR: path.join("custom", "memory"),
			HOME: path.join("home", "user"),
		};

		expect(resolveActiveMemoryDir(env, () => true)).toBe(env.PI_MEMORY_DIR);
	});

	test("returns the pi path when the pi folder exists", () => {
		const env = { HOME: path.join("home", "user") };
		const piPath = path.join(env.HOME, ".pi", "agent", "memory");

		expect(resolveActiveMemoryDir(env, (p) => p === piPath)).toBe(piPath);
	});

	test("falls back to ~/.oc2-memory when the pi folder is missing", () => {
		const env = { HOME: path.join("home", "user") };

		expect(resolveActiveMemoryDir(env, () => false)).toBe(path.join(env.HOME, ".oc2-memory"));
	});

	test("uses USERPROFILE for the fallback when HOME is unset", () => {
		const env = { USERPROFILE: path.join("Users", "runneradmin") };

		expect(resolveActiveMemoryDir(env, () => false)).toBe(path.join(env.USERPROFILE, ".oc2-memory"));
	});

	test("probes the filesystem once and caches the result until reset", () => {
		_resetActiveMemoryDir();
		let probes = 0;
		const exists = (p: string) => {
			probes++;
			return p.includes(".pi");
		};
		const env = { HOME: path.join("home", "user") };

		const first = _getActiveMemoryDir(env, exists);
		const second = _getActiveMemoryDir(env, exists);

		expect(first).toBe(second);
		expect(probes).toBe(1);

		_resetActiveMemoryDir();
		_getActiveMemoryDir(env, exists);
		expect(probes).toBe(2);
	});
});

describe("buildQmdSpawn", () => {
	const QMD_JS = "C:\\npm\\prefix\\node_modules\\@tobilu\\qmd\\dist\\cli\\qmd.js";

	test("invokes qmd's JS entry via node on Windows when resolution succeeds", () => {
		const out = buildQmdSpawn("qmd", ["collection", "list"], "win32", QMD_JS);
		expect(out.file).toBe("node");
		expect(out.args).toEqual([QMD_JS, "collection", "list"]);
	});

	test("no-arg qmd invocation still uses node + resolved JS path on Windows", () => {
		const out = buildQmdSpawn("qmd", [], "win32", QMD_JS);
		expect(out.file).toBe("node");
		expect(out.args).toEqual([QMD_JS]);
	});

	test("paths with spaces and `$` in user args pass through as literal argv", () => {
		const arg = "C:\\Users\\Foo Bar\\$mem";
		const out = buildQmdSpawn("qmd", ["collection", "add", arg], "win32", QMD_JS);
		expect(out.args).toEqual([QMD_JS, "collection", "add", arg]);
	});

	test("recognizes qmd.cmd and qmd.exe as qmd commands on Windows", () => {
		expect(buildQmdSpawn("qmd.cmd", ["update"], "win32", QMD_JS).file).toBe("node");
		expect(buildQmdSpawn("qmd.exe", ["update"], "win32", QMD_JS).file).toBe("node");
	});

	test("falls through to bare qmd when resolution returns null", () => {
		const out = buildQmdSpawn("qmd", ["update"], "win32", null);
		expect(out.file).toBe("qmd");
		expect(out.args).toEqual(["update"]);
	});

	test("passes through unchanged on non-Windows even with a resolved path", () => {
		const out = buildQmdSpawn("qmd", ["update"], "linux", QMD_JS);
		expect(out.file).toBe("qmd");
		expect(out.args).toEqual(["update"]);
	});

	test("passes through unchanged for non-qmd commands on Windows", () => {
		const out = buildQmdSpawn("node", ["-v"], "win32", QMD_JS);
		expect(out.file).toBe("node");
		expect(out.args).toEqual(["-v"]);
	});
});

describe("resolveQmdJsPath", () => {
	let scratchDir: string;
	beforeEach(() => {
		scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-qmd-resolve-"));
		_resetQmdJsResolutionForTest();
	});
	afterEach(() => {
		fs.rmSync(scratchDir, { recursive: true, force: true });
		_resetQmdJsResolutionForTest();
	});

	test("returns the sibling node_modules path for a PATH entry that contains the install", () => {
		const prefix = path.join(scratchDir, "prefix");
		const qmdJs = path.join(prefix, "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(qmdJs), { recursive: true });
		fs.writeFileSync(qmdJs, "// stub", "utf-8");

		const found = resolveQmdJsPath({ PATH: prefix } as NodeJS.ProcessEnv);
		expect(found).toBe(qmdJs);
	});

	test("returns null when no PATH entry has a sibling install", () => {
		const empty = path.join(scratchDir, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const found = resolveQmdJsPath({ PATH: empty } as NodeJS.ProcessEnv);
		expect(found).toBeNull();
	});

	test("caches the resolved path across calls", () => {
		const prefix = path.join(scratchDir, "prefix");
		const qmdJs = path.join(prefix, "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(qmdJs), { recursive: true });
		fs.writeFileSync(qmdJs, "// stub", "utf-8");

		const first = resolveQmdJsPath({ PATH: prefix } as NodeJS.ProcessEnv);
		// Second call with an empty PATH still returns the cached value
		const second = resolveQmdJsPath({ PATH: "" } as NodeJS.ProcessEnv);
		expect(first).toBe(qmdJs);
		expect(second).toBe(qmdJs);
	});
});

describe("shortSessionId", () => {
	test("returns first 8 characters", () => {
		expect(shortSessionId("abcdef1234567890")).toBe("abcdef12");
	});

	test("handles exactly 8 characters", () => {
		expect(shortSessionId("12345678")).toBe("12345678");
	});

	test("handles shorter string", () => {
		expect(shortSessionId("abc")).toBe("abc");
	});

	test("handles empty string", () => {
		expect(shortSessionId("")).toBe("");
	});
});

describe("readFileSafe", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("reads existing file", () => {
		const filePath = path.join(tmpDir, "test.txt");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		expect(readFileSafe(filePath)).toBe("hello world");
	});

	test("returns null for non-existent file", () => {
		expect(readFileSafe(path.join(tmpDir, "nope.txt"))).toBeNull();
	});

	test("reads empty file", () => {
		const filePath = path.join(tmpDir, "empty.txt");
		fs.writeFileSync(filePath, "", "utf-8");
		expect(readFileSafe(filePath)).toBe("");
	});

	test("reads unicode content", () => {
		const filePath = path.join(tmpDir, "unicode.txt");
		fs.writeFileSync(filePath, "Hello 🌍 world", "utf-8");
		expect(readFileSafe(filePath)).toBe("Hello 🌍 world");
	});
});

describe("dailyPath", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns path with .md extension", () => {
		const result = dailyPath("2026-02-15");
		expect(result).toEndWith("2026-02-15.md");
	});

	test("uses daily subdirectory", () => {
		const result = dailyPath("2026-02-15");
		expect(result).toContain(path.join("daily", "2026-02-15.md"));
	});

	test("rejects invalid date input", () => {
		expect(() => dailyPath("../../outside")).toThrow("Invalid daily date");
	});
});

describe("ensureDirs", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("creates memory and daily directories", () => {
		// tmpDir exists but daily subdir doesn't yet
		ensureDirs();
		expect(fs.existsSync(tmpDir)).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "daily"))).toBe(true);
	});

	test("is idempotent", () => {
		ensureDirs();
		ensureDirs(); // should not throw
		expect(fs.existsSync(tmpDir)).toBe(true);
	});
});

// ==========================================================================
// 2. Scratchpad parsing and serialization
// ==========================================================================

describe("parseScratchpad", () => {
	test("parses unchecked items", () => {
		const items = parseScratchpad("- [ ] Fix bug\n- [ ] Add feature\n");
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({ done: false, text: "Fix bug", meta: "" });
		expect(items[1]).toEqual({ done: false, text: "Add feature", meta: "" });
	});

	test("parses checked items", () => {
		const items = parseScratchpad("- [x] Done task\n- [X] Also done\n");
		expect(items).toHaveLength(2);
		expect(items[0].done).toBe(true);
		expect(items[1].done).toBe(true);
	});

	test("parses mixed items", () => {
		const items = parseScratchpad("- [ ] Open\n- [x] Done\n- [ ] Also open\n");
		expect(items).toHaveLength(3);
		expect(items[0].done).toBe(false);
		expect(items[1].done).toBe(true);
		expect(items[2].done).toBe(false);
	});

	test("captures metadata comment from preceding line", () => {
		const content = "<!-- 2026-02-15 10:00:00 [abc12345] -->\n- [ ] Task with meta\n";
		const items = parseScratchpad(content);
		expect(items).toHaveLength(1);
		expect(items[0].meta).toBe("<!-- 2026-02-15 10:00:00 [abc12345] -->");
		expect(items[0].text).toBe("Task with meta");
	});

	test("ignores non-checklist lines", () => {
		const content = "# Scratchpad\n\nSome text\n- [ ] Real item\n- Not a checkbox\n";
		const items = parseScratchpad(content);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Real item");
	});

	test("handles empty content", () => {
		expect(parseScratchpad("")).toHaveLength(0);
	});

	test("handles content with only headers", () => {
		expect(parseScratchpad("# Scratchpad\n\n")).toHaveLength(0);
	});

	test("handles items without metadata", () => {
		const items = parseScratchpad("- [ ] No meta item\n");
		expect(items[0].meta).toBe("");
	});

	test("does not pick up non-comment lines as metadata", () => {
		const content = "some random line\n- [ ] Task\n";
		const items = parseScratchpad(content);
		expect(items[0].meta).toBe("");
	});

	test("handles item at first line (no preceding line for meta)", () => {
		const items = parseScratchpad("- [ ] First line item\n");
		expect(items).toHaveLength(1);
		expect(items[0].meta).toBe("");
	});
});

describe("serializeScratchpad", () => {
	test("serializes unchecked items", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "Fix bug", meta: "" }];
		const result = serializeScratchpad(items);
		expect(result).toBe("# Scratchpad\n\n- [ ] Fix bug\n");
	});

	test("serializes checked items", () => {
		const items: ScratchpadItem[] = [{ done: true, text: "Done task", meta: "" }];
		const result = serializeScratchpad(items);
		expect(result).toBe("# Scratchpad\n\n- [x] Done task\n");
	});

	test("includes metadata comments", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "Task", meta: "<!-- 2026-02-15 [abc] -->" }];
		const result = serializeScratchpad(items);
		expect(result).toContain("<!-- 2026-02-15 [abc] -->");
		expect(result).toContain("- [ ] Task");
	});

	test("serializes empty list", () => {
		const result = serializeScratchpad([]);
		expect(result).toBe("# Scratchpad\n\n");
	});

	test("round-trips correctly", () => {
		const original: ScratchpadItem[] = [
			{ done: false, text: "Open task", meta: "<!-- ts [sid] -->" },
			{ done: true, text: "Done task", meta: "<!-- ts2 [sid2] -->" },
			{ done: false, text: "Another open", meta: "" },
		];
		const serialized = serializeScratchpad(original);
		const parsed = parseScratchpad(serialized);
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toEqual(original[0]);
		expect(parsed[1]).toEqual(original[1]);
		expect(parsed[2]).toEqual(original[2]);
	});
});

// ==========================================================================
// 3. buildMemoryContext
// ==========================================================================

describe("buildMemoryContext", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns empty string when no memory files exist", () => {
		ensureDirs();
		expect(buildMemoryContext()).toBe("");
	});

	test("includes MEMORY.md content", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Important fact", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("## MEMORY.md (long-term)");
		expect(ctx).toContain("Important fact");
	});

	test("includes open scratchpad items only", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [ ] Open item\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("Open item");
		expect(ctx).not.toContain("Done item");
	});

	test("excludes scratchpad section when all items are done", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).not.toContain("SCRATCHPAD");
	});

	test("includes today's daily log", () => {
		ensureDirs();
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`## Daily log: ${today} (today)`);
		expect(ctx).toContain("Today's work");
	});

	test("includes yesterday's daily log", () => {
		ensureDirs();
		const yesterday = yesterdayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`## Daily log: ${yesterday} (yesterday)`);
		expect(ctx).toContain("Yesterday's work");
	});

	test("combines all sections with separators", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Daily content", "utf-8");

		const ctx = buildMemoryContext();
		expect(ctx).toStartWith("# Memory");
		expect(ctx).toContain("---");
		expect(ctx).toContain("Memory content");
		expect(ctx).toContain("Task");
		expect(ctx).toContain("Daily content");
	});

	test("ignores empty/whitespace-only files", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "   \n\n  ", "utf-8");
		expect(buildMemoryContext()).toBe("");
	});
});

// ==========================================================================
// 4. QMD helper functions
// ==========================================================================

describe("qmdInstallInstructions", () => {
	test("includes qmd repo URL", () => {
		expect(qmdInstallInstructions()).toContain("github.com/tobi/qmd");
	});

	test("includes setup commands", () => {
		const instructions = qmdInstallInstructions();
		expect(instructions).toContain("qmd collection add");
		expect(instructions).toContain("qmd embed");
	});
});

describe("qmdCollectionInstructions", () => {
	test("mentions collection not configured", () => {
		expect(qmdCollectionInstructions()).toContain("pi-memory");
	});

	test("includes setup commands", () => {
		const instructions = qmdCollectionInstructions();
		expect(instructions).toContain("qmd collection add");
		expect(instructions).toContain("qmd embed");
	});
});

describe("scheduleQmdUpdate", () => {
	beforeEach(() => {
		_clearUpdateTimer();
	});
	afterEach(() => {
		_clearUpdateTimer();
		_setQmdAvailable(false);
	});

	test("does nothing when qmd is not available", () => {
		_setQmdAvailable(false);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).toBeNull();
	});

	test("sets a timer when qmd is available", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).not.toBeNull();
		_clearUpdateTimer();
	});

	test("debounces multiple calls", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		const firstTimer = _getUpdateTimer();
		scheduleQmdUpdate();
		const secondTimer = _getUpdateTimer();
		// Timer should be replaced (different reference)
		expect(secondTimer).not.toBeNull();
		expect(firstTimer).not.toBe(secondTimer);
		_clearUpdateTimer();
	});

	test("chains qmd embed after the debounced update", async () => {
		_setQmdAvailable(true);
		const calls: string[][] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push(args);
			cb(null, "", "");
		}) as any);
		try {
			scheduleQmdUpdate();
			await new Promise((r) => setTimeout(r, 700));
			expect(calls).toEqual([["update"], ["embed"]]);
		} finally {
			_resetExecFileForTest();
			_clearEmbedInFlight();
		}
	});
});

describe("ensureQmdEmbed", () => {
	afterEach(() => {
		_resetExecFileForTest();
		_clearEmbedInFlight();
		_setQmdAvailable(false);
		delete process.env.PI_MEMORY_QMD_UPDATE;
	});

	test("returns false when qmd is not available", () => {
		_setQmdAvailable(false);
		expect(ensureQmdEmbed()).toBe(false);
	});

	test("returns false when background updates are disabled", () => {
		_setQmdAvailable(true);
		process.env.PI_MEMORY_QMD_UPDATE = "off";
		expect(ensureQmdEmbed()).toBe(false);
	});

	test("spawns qmd embed and clears the in-flight flag when it finishes", () => {
		_setQmdAvailable(true);
		const calls: string[][] = [];
		let finish: (() => void) | null = null;
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push(args);
			finish = () => cb(null, "", "");
		}) as any);

		expect(ensureQmdEmbed()).toBe(true);
		expect(calls).toEqual([["embed"]]);
		expect(_getEmbedInFlight()).toBe(true);

		finish?.();
		expect(_getEmbedInFlight()).toBe(false);
	});

	test("queues another embed if requested while one is already running", () => {
		_setQmdAvailable(true);
		const calls: string[][] = [];
		const finishers: (() => void)[] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push(args);
			finishers.push(() => cb(null, "", ""));
		}) as any);

		expect(ensureQmdEmbed()).toBe(true);
		expect(calls).toEqual([["embed"]]);

		// A second request arrives while the first embed is still running.
		expect(ensureQmdEmbed()).toBe(true);
		expect(calls).toEqual([["embed"]]);

		// Finishing the first embed immediately starts the queued one.
		finishers[0]?.();
		expect(calls).toEqual([["embed"], ["embed"]]);
		expect(_getEmbedInFlight()).toBe(true);

		finishers[1]?.();
		expect(_getEmbedInFlight()).toBe(false);
	});
});

// ==========================================================================
// 5. Tool: memory_write
// ==========================================================================

describe("memory_write tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		tools = memoryTools();
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_write).toBeDefined();
		expect(tools.memory_write.name).toBe("memory_write");
	});

	test("appends to empty MEMORY.md", async () => {
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "User likes cats" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("User likes cats");
		expect(content).toContain("<!-- ");
		expect(result.content[0].text).toContain("Appended to MEMORY.md");
		expect(result.content[0].text).toContain("MEMORY.md was empty");
		expect(result.details.target).toBe("long_term");
		expect(result.details.mode).toBe("append");
	});

	test("appends to existing MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Existing content", "utf-8");
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "New fact" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Existing content");
		expect(content).toContain("New fact");
		expect(result.content[0].text).toContain("Existing MEMORY.md preview");
		expect(result.content[0].text).toContain("Existing content");
	});

	test("overwrites MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old content", "utf-8");
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "Brand new", mode: "overwrite" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Brand new");
		expect(content).not.toContain("Old content");
		expect(content).toContain("<!-- last updated:");
		expect(result.details.mode).toBe("overwrite");
	});

	test("appends to daily log", async () => {
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "daily", content: "Did some work" },
			null,
			null,
			ctx,
		);
		const today = todayStr();
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		expect(content).toContain("Did some work");
		expect(result.content[0].text).toContain("Appended to daily log");
		expect(result.details.target).toBe("daily");
	});

	test("appends to existing daily log", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Morning entry", "utf-8");
		const ctx = createMockCtx();
		await tools.memory_write.execute("call1", { target: "daily", content: "Afternoon entry" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		expect(content).toContain("Morning entry");
		expect(content).toContain("Afternoon entry");
	});

	test("includes session ID in metadata comment", async () => {
		const ctx = createMockCtx("mysession12345678");
		await tools.memory_write.execute("call1", { target: "long_term", content: "Test" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("[mysessio]"); // first 8 chars
	});

	test("includes timestamp in metadata comment", async () => {
		const ctx = createMockCtx();
		await tools.memory_write.execute("call1", { target: "long_term", content: "Test" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		// Should have a timestamp like "2026-02-15 10:30:00"
		expect(content).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	test("default mode is append", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old", "utf-8");
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "New" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Old");
		expect(content).toContain("New");
		expect(result.details.mode).toBe("append");
	});
});

// ==========================================================================
// 6. Tool: scratchpad
// ==========================================================================

describe("scratchpad tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		tools = memoryTools();
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.scratchpad).toBeDefined();
		expect(tools.scratchpad.name).toBe("scratchpad");
	});

	test("list on empty scratchpad", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("call1", { action: "list" }, null, null, ctx);
		expect(result.content[0].text).toBe("Scratchpad is empty.");
	});

	test("add item", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("call1", { action: "add", text: "Fix login bug" }, null, null, ctx);
		expect(result.content[0].text).toContain("- [ ] Fix login bug");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("Fix login bug");
		expect(content).toContain("[ ]");
	});

	test("add without text returns error", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("call1", { action: "add" }, null, null, ctx);
		expect(result.content[0].text).toContain("Error");
		expect(result.content[0].text).toContain("'text' is required");
	});

	test("done marks item as checked", async () => {
		const ctx = createMockCtx();
		// Add an item first
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix login bug" }, null, null, ctx);
		// Mark it done
		const result = await tools.scratchpad.execute("c2", { action: "done", text: "login" }, null, null, ctx);
		expect(result.content[0].text).toContain("Updated");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("[x]");
	});

	test("done matches by case-insensitive substring", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix Login Bug" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "done", text: "LOGIN" }, null, null, ctx);
		expect(result.content[0].text).toContain("Updated");
	});

	test("done without text returns error", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("c1", { action: "done" }, null, null, ctx);
		expect(result.content[0].text).toContain("Error");
	});

	test("done with no matching item", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix bug" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "done", text: "nonexistent" }, null, null, ctx);
		expect(result.content[0].text).toContain("No matching");
	});

	test("done on already-done item finds no match", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Task" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "done", text: "Task" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c3", { action: "done", text: "Task" }, null, null, ctx);
		expect(result.content[0].text).toContain("No matching open item");
	});

	test("undo unchecks a done item", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Task to undo" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "done", text: "undo" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c3", { action: "undo", text: "undo" }, null, null, ctx);
		expect(result.content[0].text).toContain("Updated");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("[ ]");
		expect(content).not.toContain("[x]");
	});

	test("undo without text returns error", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("c1", { action: "undo" }, null, null, ctx);
		expect(result.content[0].text).toContain("Error");
	});

	test("undo on open item finds no match", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Open task" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "undo", text: "Open task" }, null, null, ctx);
		expect(result.content[0].text).toContain("No matching done item");
	});

	test("clear_done removes checked items", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Keep this" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "add", text: "Remove this" }, null, null, ctx);
		await tools.scratchpad.execute("c3", { action: "done", text: "Remove" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c4", { action: "clear_done" }, null, null, ctx);
		expect(result.content[0].text).toContain("Cleared 1 done item(s)");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("Keep this");
		expect(content).not.toContain("Remove this");
	});

	test("clear_done with no done items", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Open" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "clear_done" }, null, null, ctx);
		expect(result.content[0].text).toContain("Cleared 0 done item(s)");
	});

	test("list shows all items with counts", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Open 1" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "add", text: "Open 2" }, null, null, ctx);
		await tools.scratchpad.execute("c3", { action: "add", text: "Will be done" }, null, null, ctx);
		await tools.scratchpad.execute("c4", { action: "done", text: "Will be done" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c5", { action: "list" }, null, null, ctx);
		expect(result.details.count).toBe(3);
		expect(result.details.open).toBe(2);
	});

	test("done only matches first matching item", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix bug A" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "add", text: "Fix bug B" }, null, null, ctx);
		await tools.scratchpad.execute("c3", { action: "done", text: "Fix bug" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		// Only first match should be done
		const items = parseScratchpad(content);
		expect(items[0].done).toBe(true);
		expect(items[1].done).toBe(false);
	});
});

// ==========================================================================
// 7. Tool: memory_read
// ==========================================================================

describe("memory_read tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		tools = memoryTools();
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_read).toBeDefined();
		expect(tools.memory_read.name).toBe("memory_read");
	});

	// -- long_term --

	test("read long_term when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "My memories", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toBe("My memories");
	});

	test("read long_term when file does not exist", async () => {
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	test("read long_term when file is empty", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		// readFileSafe returns "" which is falsy, so treated as missing
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	// -- scratchpad --

	test("read scratchpad when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "scratchpad" }, null, null, {});
		expect(result.content[0].text).toContain("Task");
	});

	test("read scratchpad when empty", async () => {
		const result = await tools.memory_read.execute("c1", { target: "scratchpad" }, null, null, {});
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	test("read scratchpad when whitespace only", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "   \n  ", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "scratchpad" }, null, null, {});
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	// -- daily --

	test("read daily defaults to today", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's log", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "daily" }, null, null, {});
		expect(result.content[0].text).toBe("Today's log");
		expect(result.details.date).toBe(today);
	});

	test("read daily with specific date", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-01-01.md"), "New year log", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "daily", date: "2026-01-01" }, null, null, {});
		expect(result.content[0].text).toBe("New year log");
	});

	test("read daily when file does not exist", async () => {
		const result = await tools.memory_read.execute("c1", { target: "daily", date: "1999-01-01" }, null, null, {});
		expect(result.content[0].text).toContain("No daily log for 1999-01-01");
	});

	test("read daily rejects path traversal in date", async () => {
		const outsideBase = path.join(
			os.tmpdir(),
			`pi-memory-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const outsideFile = `${outsideBase}.md`;
		fs.writeFileSync(outsideFile, "TOP SECRET", "utf-8");

		try {
			const result = await tools.memory_read.execute(
				"c1",
				{ target: "daily", date: `../../${path.basename(outsideBase)}` },
				null,
				null,
				{},
			);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Invalid date format");
		} finally {
			fs.rmSync(outsideFile, { force: true });
		}
	});

	// -- list --

	test("list daily logs when multiple exist", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-14.md"), "b", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-13.md"), "c", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "list" }, null, null, {});
		expect(result.content[0].text).toContain("2026-02-15.md");
		expect(result.content[0].text).toContain("2026-02-14.md");
		expect(result.content[0].text).toContain("2026-02-13.md");
		expect(result.details.files).toHaveLength(3);
		// Should be reverse sorted (newest first)
		expect(result.details.files[0]).toBe("2026-02-15.md");
	});

	test("list daily logs when none exist", async () => {
		const result = await tools.memory_read.execute("c1", { target: "list" }, null, null, {});
		expect(result.content[0].text).toContain("No daily logs found");
	});

	test("list ignores non-md files", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "notes.txt"), "b", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "list" }, null, null, {});
		expect(result.details.files).toHaveLength(1);
	});
});

// ==========================================================================
// 8. Tool: memory_search
// ==========================================================================

describe("runQmdSearch qmd diagnostics", () => {
	afterEach(() => {
		_resetExecFileForTest();
	});

	test("strips qmd spinner control sequences from stderr failures", async () => {
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(
				new Error("Command failed: qmd vsearch"),
				"",
				"\u001b[?25l\u001b[?25h\u001b[2K\u001b[1A\u001b[Greal diagnostic",
			);
		}) as any);

		await expect(runQmdSearch("semantic", "query", 5)).rejects.toThrow("real diagnostic");
		await expect(runQmdSearch("semantic", "query", 5)).rejects.not.toThrow("[?25");
	});

	test("strips qmd spinner control sequences from the fallback error message", async () => {
		const spinner = "\u001b[?25l\u001b[?25h";
		const commandError = new Error(`Command failed: qmd vsearch\n${spinner}`);
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(commandError, "", spinner);
		}) as any);

		let failure: unknown;
		try {
			await runQmdSearch("semantic", "query", 5);
		} catch (err) {
			failure = err;
		}

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Command failed: qmd vsearch");
		expect((failure as Error).message).not.toContain("\u001b");
	});

	test("uses the configured qmd search timeout in execution and diagnostics", async () => {
		const previousTimeout = process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
		process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = "90000";
		let observedTimeout: number | undefined;
		try {
			const timeoutErr = Object.assign(new Error("Command failed: qmd vsearch"), { killed: true });
			_setExecFileForTest(((_file: string, _args: string[], opts: any, cb: any) => {
				observedTimeout = opts.timeout;
				cb(timeoutErr, "", "\u001b[?25l\u001b[?25h");
			}) as any);

			await expect(runQmdSearch("semantic", "query", 5)).rejects.toThrow("qmd timed out after 90s");
			expect(observedTimeout).toBe(90_000);
		} finally {
			if (previousTimeout === undefined) delete process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
			else process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = previousTimeout;
		}
	});

	test("removes FORCE_COLOR and sets NO_COLOR for qmd child processes", () => {
		const env = buildQmdEnv({ FORCE_COLOR: "3", NO_COLOR: undefined, PATH: "bin" });

		expect(env.FORCE_COLOR).toBeUndefined();
		expect(env.NO_COLOR).toBe("1");
		expect(env.PATH).toBe("bin");
	});
});

describe("getQmdSearchTimeoutMs", () => {
	test("accepts positive integer milliseconds and defaults invalid values", () => {
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "90000" })).toBe(90_000);
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "0.5" })).toBe(60_000);
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "0" })).toBe(60_000);
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "invalid" })).toBe(60_000);
	});
});

describe("searchMemoryMarkdown", () => {
	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
	});

	afterEach(cleanupTmpDir);

	test("finds a term in MEMORY.md", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Memory\n\nWe use tabs for indentation.\n", "utf-8");

		const results = searchMemoryMarkdown("tabs", 5);

		expect(results.length).toBe(1);
		expect(results[0].path).toBe(path.join(tmpDir, "MEMORY.md"));
		expect(results[0].content).toContain("tabs");
	});

	test("finds a term in a daily file and prefers the newest on a tie", () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2024-01-01.md"), "alpha beta\nalpha\n", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2024-02-01.md"), "alpha beta\nalpha\n", "utf-8");

		const results = searchMemoryMarkdown("alpha", 5);

		expect(results.length).toBe(2);
		expect(results[0].path).toBe(path.join(tmpDir, "daily", "2024-02-01.md"));
	});

	test("requires all terms to match", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "alpha only\n", "utf-8");

		expect(searchMemoryMarkdown("alpha beta", 5)).toEqual([]);
	});

	test("is case-insensitive", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Remember TABS\n", "utf-8");

		const results = searchMemoryMarkdown("tabs", 5);

		expect(results.length).toBe(1);
	});

	test("returns [] and does not throw when nothing matches", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "nothing here\n", "utf-8");

		expect(searchMemoryMarkdown("zzz", 5)).toEqual([]);
	});

	test("does not throw when the daily directory is missing", () => {
		fs.rmSync(path.join(tmpDir, "daily"), { recursive: true, force: true });
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "alpha\n", "utf-8");

		expect(() => searchMemoryMarkdown("alpha", 5)).not.toThrow();
		expect(searchMemoryMarkdown("alpha", 5).length).toBe(1);
	});

	test("respects the limit", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "alpha alpha\n", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2024-01-01.md"), "alpha\n", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2024-01-02.md"), "alpha\n", "utf-8");

		expect(searchMemoryMarkdown("alpha", 1).length).toBe(1);
	});
});

describe("memory_search tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		tools = memoryTools();
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_search).toBeDefined();
		expect(tools.memory_search.name).toBe("memory_search");
	});

	test("falls back to markdown search when qmd is unavailable", async () => {
		const execStub = ((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any;

		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		try {
			fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "We use tabs for indentation.\n", "utf-8");
			const result = await tools.memory_search.execute("c1", { query: "tabs" }, null, null, {});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toContain("qmd");
			expect(result.content[0].text).toContain("tabs");
			expect(result.details.fallback).toBe("markdown");
			expect(result.details.count).toBe(1);
		} finally {
			_resetExecFileForTest();
		}
	});

	test("defaults mode to keyword and limit to 5", () => {
		// Verify through the tool's parameter schema description
		const desc = tools.memory_search.description;
		expect(desc).toContain("keyword");
		expect(desc).toContain("semantic");
		expect(desc).toContain("deep");
	});

	test("says semantic mode fell back to keyword when qmd is unavailable", async () => {
		const execStub = ((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any;

		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		try {
			const result = await tools.memory_search.execute(
				"c1",
				{ query: "anything", mode: "semantic" },
				null,
				null,
				{},
			);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toContain("semantic");
			expect(result.content[0].text.toLowerCase()).toContain("keyword");
			expect(result.details.fallback).toBe("markdown");
		} finally {
			_resetExecFileForTest();
		}
	});
});

describe("memory_status tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		tools = memoryTools();
	});

	afterEach(() => {
		_resetExecFileForTest();
		cleanupTmpDir();
	});

	test("registers with correct name", () => {
		expect(tools.memory_status).toBeDefined();
		expect(tools.memory_status.name).toBe("memory_status");
	});

	test("reports file inventory and qmd-unavailable state without throwing", async () => {
		const execStub = ((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any;
		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "remember this");

		const result = await tools.memory_status.execute("c1", {}, null, null, {});
		const text = result.content[0].text;
		expect(text).toContain("Memory status");
		expect(text).toContain("qmd available: ✗");
		expect(result.details.qmd).toBe(false);
		expect(result.details.longTermChars).toBeGreaterThan(0);
	});
});

// ==========================================================================
// Local calendar dates (regression: daily logs were keyed to UTC)
// ==========================================================================

describe("local calendar dates", () => {
	const pad = (n: number) => String(n).padStart(2, "0");

	test("todayStr returns the LOCAL calendar date, not UTC", () => {
		const now = new Date();
		const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		expect(todayStr()).toBe(local);
	});

	test("yesterdayStr returns the LOCAL calendar date minus one day", () => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		expect(yesterdayStr()).toBe(local);
	});

	test("nowTimestamp uses local date and local hour", () => {
		const now = new Date();
		const ts = nowTimestamp();
		expect(ts.slice(0, 10)).toBe(todayStr());
		// Tolerate the clock ticking across an hour boundary mid-test.
		const hour = Number(ts.slice(11, 13));
		expect([now.getHours(), new Date().getHours()]).toContain(hour);
	});
});

// ==========================================================================
// Line-preserving scratchpad mutations (regression: round-trip deleted
// any non-checklist content from SCRATCHPAD.md)
// ==========================================================================

describe("line-preserving scratchpad mutations", () => {
	const file = [
		"# Scratchpad",
		"",
		"Hand-written note that must survive.",
		"",
		"## Ideas",
		"<!-- 2026-07-08 10:00:00 [abc12345] -->",
		"- [ ] fix the flaky test",
		"  extra detail under the item",
		"<!-- 2026-07-08 10:05:00 [abc12345] -->",
		"- [x] ship the release",
		"",
	].join("\n");

	test("scratchpadAdd appends and preserves all existing content", () => {
		const out = scratchpadAdd(file, "water the plants", "<!-- meta -->");
		expect(out).toContain("Hand-written note that must survive.");
		expect(out).toContain("## Ideas");
		expect(out).toContain("  extra detail under the item");
		expect(out.endsWith("<!-- meta -->\n- [ ] water the plants\n")).toBe(true);
	});

	test("scratchpadAdd creates the standard skeleton for empty content", () => {
		const out = scratchpadAdd("", "first item", "<!-- meta -->");
		expect(out.startsWith("# Scratchpad")).toBe(true);
		expect(out).toContain("- [ ] first item");
	});

	test("scratchpadToggle flips only the matched item", () => {
		const { content, matched } = scratchpadToggle(file, "flaky", true);
		expect(matched).toBe(true);
		expect(content).toContain("- [x] fix the flaky test");
		expect(content).toContain("- [x] ship the release");
		expect(content).toContain("Hand-written note that must survive.");
	});

	test("scratchpadToggle can uncheck a done item", () => {
		const { content, matched } = scratchpadToggle(file, "ship", false);
		expect(matched).toBe(true);
		expect(content).toContain("- [ ] ship the release");
	});

	test("scratchpadToggle reports no match honestly", () => {
		expect(scratchpadToggle(file, "nonexistent", true).matched).toBe(false);
	});

	test("scratchpadClearDone removes done items and their meta, keeps the rest", () => {
		const { content, removed } = scratchpadClearDone(file);
		expect(removed).toBe(1);
		expect(content).not.toContain("ship the release");
		expect(content).not.toContain("10:05:00");
		expect(content).toContain("- [ ] fix the flaky test");
		expect(content).toContain("Hand-written note that must survive.");
		expect(content).toContain("## Ideas");
	});

	test("scratchpadClearDone preserves hand-written HTML comments", () => {
		const content = ["# Scratchpad", "", "<!-- Keep this deployment note. -->", "- [x] ship the release", ""].join(
			"\n",
		);
		const result = scratchpadClearDone(content);
		expect(result.removed).toBe(1);
		expect(result.content).toContain("<!-- Keep this deployment note. -->");
	});
});

// ==========================================================================
// clampSearchLimit (regression: NaN/0/negative/huge limits reached qmd -n)
// ==========================================================================

describe("clampSearchLimit", () => {
	test("defaults when undefined or NaN", () => {
		expect(clampSearchLimit(undefined)).toBe(5);
		expect(clampSearchLimit(Number.NaN)).toBe(5);
	});

	test("clamps to the valid range and floors fractions", () => {
		expect(clampSearchLimit(0)).toBe(1);
		expect(clampSearchLimit(-3)).toBe(1);
		expect(clampSearchLimit(3.7)).toBe(3);
		expect(clampSearchLimit(9999)).toBe(25);
	});
});

// ==========================================================================
// forgetBlocks + memory_forget (deletion as a first-class operation)
// ==========================================================================

describe("forgetBlocks", () => {
	const file = [
		"Hand-written note about deployment.",
		"",
		"<!-- 2026-07-01 10:00:00 [abc] -->",
		"Balance is $12.69 #finance",
		"",
		"<!-- 2026-07-03 09:00:00 [def] -->",
		"Prefers dark mode #preference",
	].join("\n");

	test("removes the matching entry with its timestamp stamp", () => {
		const { content, removed } = forgetBlocks(file, "$12.69");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(removed[0]).toContain("2026-07-01");
		expect(content).not.toContain("$12.69");
		expect(content).toContain("Prefers dark mode");
		expect(content).toContain("Hand-written note about deployment.");
	});

	test("match is case-insensitive", () => {
		const { removed } = forgetBlocks(file, "DARK MODE");
		expect(removed).toHaveLength(1);
	});

	test("removes multiple matching blocks", () => {
		const { content, removed } = forgetBlocks(file, "20");
		expect(removed).toHaveLength(2); // both stamped entries contain 2026 dates
		expect(content).toContain("Hand-written note");
	});

	test("removes an entire stamped entry when a later paragraph matches", () => {
		const content = [
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\n");
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(removed[0]).toContain("Supporting detail");
		expect(remaining).not.toContain("Balance is $12.69");
		expect(remaining).not.toContain("Supporting detail");
		expect(remaining).toContain("Prefers dark mode");
	});

	test("preserves CRLF entry boundaries when removing a multi-paragraph entry", () => {
		const content = [
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\r\n");
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(removed[0]).toContain("Supporting detail");
		expect(remaining).not.toContain("Balance is $12.69");
		expect(remaining).toContain("Prefers dark mode");
	});

	test("recognizes the first generated entry when the file starts with a UTF-8 BOM", () => {
		const content = `\uFEFF${[
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\n")}`;
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(remaining).not.toContain("Balance is $12.69");
		expect(remaining).toContain("Prefers dark mode");
	});

	test("no match leaves content untouched", () => {
		const { content, removed } = forgetBlocks(file, "nonexistent");
		expect(removed).toHaveLength(0);
		expect(content).toBe(file);
	});

	test("empty match removes nothing", () => {
		expect(forgetBlocks(file, "  ").removed).toHaveLength(0);
	});

	test("removing the only entry empties the file", () => {
		const { content, removed } = forgetBlocks("only fact here\n", "only fact");
		expect(removed).toHaveLength(1);
		expect(content).toBe("");
	});
});

describe("memory_forget tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		tools = memoryTools();
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_forget).toBeDefined();
	});

	test("removes matching entry from MEMORY.md and echoes it back", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "MEMORY.md"),
			"<!-- ts [s] -->\nBalance is $12.69\n\nPrefers tabs over spaces\n",
			"utf-8",
		);
		const result = await tools.memory_forget.execute("c1", { match: "$12.69" }, null, null, {});
		expect(result.content[0].text).toContain("Removed 1 entry");
		expect(result.content[0].text).toContain("$12.69"); // recoverable echo
		const remaining = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(remaining).not.toContain("$12.69");
		expect(remaining).toContain("Prefers tabs");
	});

	test("reports no match without touching the file", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "a fact\n", "utf-8");
		const result = await tools.memory_forget.execute("c1", { match: "zzz" }, null, null, {});
		expect(result.content[0].text).toContain("No entries matching");
		expect(fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8")).toBe("a fact\n");
	});

	test("targets a specific daily log by date", async () => {
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "old wrong fact\n\nkeep me\n", "utf-8");
		const result = await tools.memory_forget.execute(
			"c1",
			{ match: "wrong fact", target: "daily", date: "2026-07-01" },
			null,
			null,
			{},
		);
		expect(result.content[0].text).toContain("Removed 1 entry");
		const remaining = fs.readFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "utf-8");
		expect(remaining).toContain("keep me");
		expect(remaining).not.toContain("wrong fact");

		const restoreResult = await tools.memory_restore.execute(
			"c2",
			{ recoveryId: result.details.recoveryId },
			null,
			null,
			{},
		);
		expect(restoreResult.content[0].text).toContain("Restored 1 entry");
		const restored = fs.readFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "utf-8");
		expect(restored).toContain("wrong fact");
		expect(restored).toContain("keep me");
	});

	test("rejects empty match and bad dates", async () => {
		const r1 = await tools.memory_forget.execute("c1", { match: "  " }, null, null, {});
		expect(r1.isError).toBe(true);
		const r2 = await tools.memory_forget.execute(
			"c1",
			{ match: "x", target: "daily", date: "not-a-date" },
			null,
			null,
			{},
		);
		expect(r2.isError).toBe(true);
	});

	test("handles empty memory gracefully", async () => {
		const result = await tools.memory_forget.execute("c1", { match: "x" }, null, null, {});
		expect(result.content[0].text).toContain("nothing to forget");
	});

	test("rejects invalid recovery IDs without reading outside the recovery directory", async () => {
		const result = await tools.memory_restore.execute("c1", { recoveryId: "../../MEMORY.md" }, null, null, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("No valid recovery record");
	});

	test("persists complete removed content and restores it by visible recovery ID", async () => {
		const longEntry = `<!-- 2026-07-01 10:00:00 [abc] -->\nwrong fact ${"x".repeat(4500)} recovery-tail`;
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), longEntry, "utf-8");
		const forgetResult = await tools.memory_forget.execute("c1", { match: "wrong fact" }, null, null, {});
		expect(forgetResult.content[0].text).not.toContain("recovery-tail");
		expect(forgetResult.content[0].text).toContain("memory_restore");
		expect(forgetResult.content[0].text).toContain(forgetResult.details.recoveryId);

		const recoveryPath = path.join(tmpDir, "recovery", `${forgetResult.details.recoveryId}.json`);
		const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf-8"));
		expect(recovery.removedContent).toEqual([longEntry]);
		expect(forgetResult.details.removedContent).toBeUndefined();

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "A later fact that must survive.\n", "utf-8");

		const restoreResult = await tools.memory_restore.execute(
			"c2",
			{ recoveryId: forgetResult.details.recoveryId },
			null,
			null,
			{},
		);
		expect(restoreResult.content[0].text).toContain("Restored 1 entry");
		const restoredMemory = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(restoredMemory).toContain("recovery-tail");
		expect(restoredMemory).toContain("A later fact that must survive.");

		const secondRestore = await tools.memory_restore.execute(
			"c3",
			{ recoveryId: forgetResult.details.recoveryId },
			null,
			null,
			{},
		);
		expect(secondRestore.content[0].text).toContain("already restored");
	});
});

// ==========================================================================
// 13. probeEmbeddings timeout behavior
// ==========================================================================

describe("probeEmbeddings", () => {
	const ENV_KEY = "PI_MEMORY_EMBED_PROBE_TIMEOUT_MS";
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		_resetExecFileForTest();
		if (previous === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = previous;
	});

	test("defaults to a probe timeout with headroom over a contended qmd call", () => {
		expect(getEmbedProbeTimeoutMs()).toBeGreaterThanOrEqual(15_000);
	});

	test("honors PI_MEMORY_EMBED_PROBE_TIMEOUT_MS override", () => {
		process.env[ENV_KEY] = "9000";
		expect(getEmbedProbeTimeoutMs()).toBe(9_000);
	});

	test("ignores invalid PI_MEMORY_EMBED_PROBE_TIMEOUT_MS values", () => {
		for (const bad of ["0", "-1", "abc", "1.5"]) {
			process.env[ENV_KEY] = bad;
			expect(getEmbedProbeTimeoutMs()).toBeGreaterThanOrEqual(15_000);
		}
	});

	test("reports ready when qmd answers without an embeddings warning", async () => {
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(null, "[]", "");
		}) as any);
		expect(await probeEmbeddings()).toBe("ready");
	});

	test("reports missing when qmd warns that embeddings are needed", async () => {
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(null, "[]", "warning: need embeddings for vector search");
		}) as any);
		expect(await probeEmbeddings()).toBe("missing");
	});

	test("survives a slow probe that would trip the old hardcoded 4s race", async () => {
		process.env[ENV_KEY] = "20000";
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			setTimeout(() => cb(null, "[]", ""), 4_200);
		}) as any);
		expect(await probeEmbeddings()).toBe("ready");
	}, 30_000);

	test("bounds the qmd child process by the probe timeout, not the search timeout", async () => {
		process.env[ENV_KEY] = "15000";
		process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = "60000";
		let observedTimeout: number | undefined;
		try {
			_setExecFileForTest(((_file: string, _args: string[], opts: any, cb: any) => {
				observedTimeout = opts.timeout;
				cb(null, "[]", "");
			}) as any);
			await probeEmbeddings();
			expect(observedTimeout).toBe(15_000);
		} finally {
			delete process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
		}
	});

	test("still reports unknown when the probe genuinely times out", async () => {
		process.env[ENV_KEY] = "150";
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			setTimeout(() => cb(null, "[]", ""), 2_000);
		}) as any);
		expect(await probeEmbeddings()).toBe("unknown");
	}, 10_000);
});

// ==========================================================================
// 12. OpenCode V2 plugin skeleton + snapshot injection
// ==========================================================================

function createMockPluginCtx() {
	const handlers: Record<string, (event: any) => any> = {};
	const addedTools: any[] = [];
	const ctx = {
		tool: {
			transform(callback: (editor: { add: (tool: any) => void }) => void) {
				callback({ add: (tool) => addedTools.push(tool) });
				return Promise.resolve({ dispose: async () => {} });
			},
		},
		session: {
			hook(name: string, callback: (event: any) => any) {
				handlers[name] = callback;
				return Promise.resolve({ dispose: async () => {} });
			},
		},
		event: {
			subscribe: async function* (_options?: { signal?: AbortSignal }) {},
		},
		location: { directory: process.cwd() },
	};
	return { ctx, handlers, addedTools };
}

function makeSystemEvent(sessionID = "s1", system: Array<{ type: "text"; text: string }> = []) {
	return { sessionID, system };
}

describe("V2 setup (snapshot injection)", () => {
	let handlers: Record<string, (event: any) => any>;
	let addedTools: any[];
	let clearSetup: (() => Promise<void> | void) | undefined;

	beforeEach(async () => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		const mock = createMockPluginCtx();
		handlers = mock.handlers;
		addedTools = mock.addedTools;
		clearSetup = await setup(mock.ctx as any);
	});

	afterEach(async () => {
		setSystemTime();
		if (clearSetup) await clearSetup();
		clearSetup = undefined;
		cleanupTmpDir();
	});

	test("default export is a V2 plugin with id and setup", () => {
		expect(oc2MemoryPlugin.id).toBe("oc2-memory");
		expect(typeof oc2MemoryPlugin.setup).toBe("function");
	});

	test("registers context and compaction hooks", () => {
		expect(typeof handlers.context).toBe("function");
		expect(typeof handlers.compaction).toBe("function");
	});

	test("registers all seven memory tools via ctx.tool.transform", () => {
		expect(addedTools).toHaveLength(7);
		expect(addedTools.map((tool) => tool.name).sort()).toEqual(
			[
				"memory_write",
				"memory_forget",
				"memory_restore",
				"memory_read",
				"scratchpad",
				"memory_search",
				"memory_status",
			].sort(),
		);
		for (const tool of addedTools) {
			expect(typeof tool.execute).toBe("function");
			expect(tool.input.type).toBe("object");
		}
	});

	test("appends the snapshot once and replaces it on later turns", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "durable fact\n", "utf-8");
		const event = makeSystemEvent("s1", [{ type: "text", text: "base instructions" }]);

		handlers.context(event);
		const afterFirst = event.system.map((part) => part.text).join("\n");
		expect(afterFirst).toContain("durable fact");
		expect(afterFirst.split("<!-- oc2-memory:snapshot -->").length - 1).toBe(1);
		expect(event.system.length).toBe(2);

		handlers.context(event);
		const afterSecond = event.system.map((part) => part.text).join("\n");
		expect(afterSecond.split("<!-- oc2-memory:snapshot -->").length - 1).toBe(1);
		expect(event.system.length).toBe(2);
		expect(event.system[0].text).toBe("base instructions");
	});

	test("keeps the block byte-stable and ignores daily writes", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "durable fact\n", "utf-8");
		const event = makeSystemEvent("s1");
		handlers.context(event);
		const first = event.system[0].text;

		fs.writeFileSync(dailyPath(todayStr()), "a brand new daily note\n", "utf-8");
		handlers.context(event);
		const second = event.system[0].text;

		expect(second).toBe(first);
		expect(second).not.toContain("brand new daily note");
	});

	test("long-term write marks sessions dirty so the next turn rebuilds", async () => {
		const mockPi = { tools: memoryTools() };
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "the old fact\n", "utf-8");

		const event = makeSystemEvent("s1");
		handlers.context(event);
		const first = event.system[0].text;
		expect(first).toContain("the old fact");

		await mockPi.tools.memory_write.execute(
			"c1",
			{ target: "long_term", content: "the brand new fact" },
			null,
			null,
			createMockCtx("s1"),
		);

		handlers.context(event);
		const second = event.system[0].text;
		expect(second).toContain("the brand new fact");
		expect(second).not.toBe(first);
	});

	test("memory_forget and memory_restore mark sessions dirty", async () => {
		const mockPi = { tools: memoryTools() };
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "<!-- ts [s] -->\nsecret fact\n\nkeep me\n", "utf-8");

		const event = makeSystemEvent("s1");
		handlers.context(event);
		expect(event.system[0].text).toContain("secret fact");

		const forget = await mockPi.tools.memory_forget.execute(
			"c1",
			{ match: "secret fact" },
			null,
			null,
			createMockCtx("s1"),
		);
		handlers.context(event);
		expect(event.system[0].text).not.toContain("secret fact");
		const afterForget = event.system[0].text;

		await mockPi.tools.memory_restore.execute(
			"c2",
			{ recoveryId: forget.details.recoveryId },
			null,
			null,
			createMockCtx("s1"),
		);
		handlers.context(event);
		expect(event.system[0].text).not.toBe(afterForget);
		expect(event.system[0].text).toContain("secret fact");
	});

	test("daily and scratchpad writes leave the snapshot clean", async () => {
		const mockPi = { tools: memoryTools() };
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "durable fact\n", "utf-8");

		const event = makeSystemEvent("s1");
		handlers.context(event);
		const first = event.system[0].text;

		await mockPi.tools.memory_write.execute(
			"c1",
			{ target: "daily", content: "a daily note" },
			null,
			null,
			createMockCtx("s1"),
		);
		await mockPi.tools.scratchpad.execute(
			"c1",
			{ action: "add", text: "a scratchpad item" },
			null,
			null,
			createMockCtx("s1"),
		);

		handlers.context(event);
		expect(event.system[0].text).toBe(first);
	});

	test("rebuilds when the calendar day changes", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "old day fact\n", "utf-8");
		const event = makeSystemEvent("s1");
		handlers.context(event);
		expect(event.system[0].text).toContain("old day fact");

		// Changed on disk without a dirty marker: must stay cached today…
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "next day fact\n", "utf-8");
		handlers.context(event);
		expect(event.system[0].text).toContain("old day fact");
		expect(event.system[0].text).not.toContain("next day fact");

		// …and rebuild once the calendar day rolls over.
		setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		handlers.context(event);
		expect(event.system[0].text).toContain("next day fact");
	});

	test("compaction appends a handoff part, writes the daily log, and keeps the snapshot clean", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "durable fact\n", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "- [ ] open task\n", "utf-8");

		const contextEvent = makeSystemEvent("s1");
		handlers.context(contextEvent);
		const snapshotBefore = contextEvent.system[0].text;

		const event: any = { sessionID: "s1", system: [], result: "keep this result" };
		await handlers.compaction(event);

		expect(event.result).toBe("keep this result");
		expect(event.system.length).toBe(1);
		expect(event.system[0].text).toContain("<!-- oc2-memory:handoff -->");
		expect(event.system[0].text).toContain("open task");

		const daily = fs.readFileSync(dailyPath(todayStr()), "utf-8");
		expect(daily).toContain("<!-- oc2-memory:handoff -->");
		expect(daily).toContain("open task");

		// The handoff write must not dirty the snapshot.
		handlers.context(contextEvent);
		expect(contextEvent.system[0].text).toBe(snapshotBefore);
	});
});
