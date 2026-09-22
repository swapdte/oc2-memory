#!/usr/bin/env node
/**
 * oc2-memory installer CLI.
 *
 * Runs under Node (via `npx oc2-memory …`) — no Bun APIs and no Bun-only
 * imports. It edits the `plugins` array of the global OpenCode config and
 * reports memory/qmd health, reusing the plugin's own helpers as the single
 * source of truth.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCollection, detectQmd, probeEmbeddings, resolveActiveMemoryDir } from "../index.js";

const PACKAGE_SPEC = "oc2-memory";

type CliEnv = Record<string, string | undefined>;

/** A `plugins` entry: either a bare specifier or a `{ package, options }` object. */
export type PluginEntry = string | { package?: string; options?: Record<string, unknown>; [key: string]: unknown };

export interface OpenCodeConfig {
	plugins?: PluginEntry[];
	/** Legacy (V1) key. Never written or removed here, only reported by `status`. */
	plugin?: unknown;
	[key: string]: unknown;
}

/**
 * Config path: an explicit `OPENCODE_CONFIG` file path, else
 * `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/opencode/opencode.json`.
 */
export function resolveConfigPath(env: CliEnv = process.env): string {
	if (env.OPENCODE_CONFIG) return env.OPENCODE_CONFIG;
	const home = env.HOME ?? env.USERPROFILE ?? "~";
	const configHome = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
	return path.join(configHome, "opencode", "opencode.json");
}

/**
 * Read the config. A missing file yields `{}`; malformed JSON throws so callers
 * abort rather than overwrite a file they cannot understand.
 */
export function readConfig(configPath: string): OpenCodeConfig {
	if (!fs.existsSync(configPath)) return {};
	const raw = fs.readFileSync(configPath, "utf-8");
	if (!raw.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Refusing to overwrite ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Refusing to overwrite ${configPath}: expected a JSON object at the root`);
	}
	return parsed as OpenCodeConfig;
}

/** Write the config atomically (tmp + rename) with mode 0600. */
export function writeConfig(configPath: string, config: OpenCodeConfig): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const tmpPath = `${configPath}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmpPath, configPath);
	fs.chmodSync(configPath, 0o600);
}

function entryPath(entry: PluginEntry): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package;
	return undefined;
}

/** True for an absolute local path whose parent package.json declares oc2-memory. */
function isOurLocalPath(entry: PluginEntry): boolean {
	const value = entryPath(entry);
	if (!value || !path.isAbsolute(value)) return false;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(value), "package.json"), "utf-8"));
		return pkg?.name === PACKAGE_SPEC;
	} catch {
		return false;
	}
}

/**
 * Add `spec` to `plugins` unless it (or an object entry naming it) is already
 * present. Returns a new config object; the input is never mutated.
 */
export function addPluginEntry(config: OpenCodeConfig, spec: string): { config: OpenCodeConfig; added: boolean } {
	const plugins = Array.isArray(config.plugins) ? [...config.plugins] : [];
	if (plugins.some((entry) => entryPath(entry) === spec)) {
		return { config, added: false };
	}
	plugins.push(spec);
	return { config: { ...config, plugins }, added: true };
}

/**
 * Remove our entries: each explicit `specs` value plus any local path that
 * belongs to an oc2-memory checkout. Foreign entries are left untouched.
 */
export function removePluginEntry(
	config: OpenCodeConfig,
	specs: string | string[] = [PACKAGE_SPEC],
): { config: OpenCodeConfig; removed: number } {
	const plugins = Array.isArray(config.plugins) ? config.plugins : undefined;
	if (!plugins) return { config, removed: 0 };

	const wanted = new Set(Array.isArray(specs) ? specs : [specs]);
	const kept = plugins.filter((entry) => {
		const value = entryPath(entry);
		const explicit = value !== undefined && wanted.has(value);
		return !explicit && !isOurLocalPath(entry);
	});
	const removed = plugins.length - kept.length;
	if (removed === 0) return { config, removed: 0 };
	return { config: { ...config, plugins: kept }, removed };
}

/** True when dist/index.js exists and is newer than the CLI and plugin sources. */
export function isBuildCurrent(repoDir: string): boolean {
	const output = path.join(repoDir, "dist", "index.js");
	if (!fs.existsSync(output)) return false;
	const outputTime = fs.statSync(output).mtimeMs;
	for (const source of [path.join(repoDir, "index.ts"), path.join(repoDir, "bin", "cli.ts")]) {
		if (fs.existsSync(source) && fs.statSync(source).mtimeMs > outputTime) return false;
	}
	return true;
}

function buildRepo(repoDir: string): void {
	console.log(`Building plugin in ${repoDir} …`);
	execFileSync("npm", ["run", "build"], { cwd: repoDir, stdio: "inherit" });
}

export interface InstallOptions {
	/** Checkout directory to install from; registers its built `dist/`. */
	local?: string;
	/** Test seam: override the build step. */
	build?: (repoDir: string) => void;
}

/**
 * Install into `plugins`. Without `local`, registers the package spec (OpenCode
 * fetches it). With `local`, builds the checkout if needed and registers the
 * absolute `dist/` directory — the path `opencode plugin add` refuses.
 */
export async function runInstall(
	configPath: string,
	options: InstallOptions = {},
): Promise<{ spec: string; configPath: string; added: boolean }> {
	let spec = PACKAGE_SPEC;
	if (options.local) {
		const repoDir = path.resolve(options.local);
		if (!fs.existsSync(path.join(repoDir, "package.json"))) {
			throw new Error(`--local ${repoDir}: no package.json found`);
		}
		if (!isBuildCurrent(repoDir)) {
			(options.build ?? buildRepo)(repoDir);
		}
		spec = path.join(repoDir, "dist");
	}

	const config = readConfig(configPath);
	const { config: next, added } = addPluginEntry(config, spec);
	if (added) writeConfig(configPath, next);
	return { spec, configPath, added };
}

/** Remove our plugin entry. The npm cache under ~/.cache/opencode is not touched. */
export function runUninstall(configPath: string): { configPath: string; removed: number } {
	const config = readConfig(configPath);
	const { config: next, removed } = removePluginEntry(config, [PACKAGE_SPEC]);
	if (removed > 0) writeConfig(configPath, next);
	return { configPath, removed };
}

export interface StatusReport {
	configPath: string;
	configExists: boolean;
	entry: string | null;
	legacyPluginKey: boolean;
	memoryDir: string;
	qmdAvailable: boolean;
	collectionExists: boolean;
	embeddings: "ready" | "missing" | "unknown" | "n/a";
}

/** Doctor output: config entry, resolved memory dir, qmd/collection/embeddings. */
export async function runStatus(configPath: string): Promise<StatusReport> {
	const configExists = fs.existsSync(configPath);
	const config = readConfig(configPath);
	const plugins = Array.isArray(config.plugins) ? config.plugins : [];
	const own = plugins.find((entry) => entryPath(entry) === PACKAGE_SPEC || isOurLocalPath(entry));

	const memoryDir = resolveActiveMemoryDir();
	const qmdAvailable = await detectQmd();
	let collectionExists = false;
	let embeddings: StatusReport["embeddings"] = "n/a";
	if (qmdAvailable) {
		collectionExists = await checkCollection("pi-memory");
		if (collectionExists) embeddings = await probeEmbeddings();
	}

	return {
		configPath,
		configExists,
		entry: own ? (entryPath(own) ?? null) : null,
		legacyPluginKey: config.plugin !== undefined,
		memoryDir,
		qmdAvailable,
		collectionExists,
		embeddings,
	};
}

function printStatus(report: StatusReport): void {
	const entryLine = report.entry
		? `oc2-memory in plugins: yes (${report.entry})`
		: report.configExists
			? "oc2-memory in plugins: no"
			: "oc2-memory in plugins: no config file";
	console.log(
		[
			"# oc2-memory status",
			"",
			`- Config: ${report.configPath}`,
			`- ${entryLine}`,
			`- Legacy "plugin" (singular) key present: ${report.legacyPluginKey ? "yes" : "no"}`,
			`- Memory dir: ${report.memoryDir}`,
			`- qmd available: ${report.qmdAvailable ? "yes" : "no"}`,
			`- Collection pi-memory: ${report.collectionExists ? "yes" : "no"}`,
			`- Embeddings: ${report.embeddings}`,
		].join("\n"),
	);
}

const USAGE = [
	"Usage: oc2-memory <command>",
	"",
	"Commands:",
	"  install [--local <dir>]   Add the plugin to the global OpenCode config",
	"  uninstall                 Remove the plugin entry from the config",
	"  status                    Show config entry and memory/qmd health",
	"",
	"  install --local <dir> builds the checkout if needed and registers its dist/ directory.",
].join("\n");

/** CLI entry point. Returns a process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const [command, ...rest] = argv;
	const configPath = resolveConfigPath();

	try {
		if (command === "install") {
			const localIndex = rest.indexOf("--local");
			let local: string | undefined;
			if (localIndex !== -1) {
				local = rest[localIndex + 1];
				if (!local || local.startsWith("--")) {
					console.error("oc2-memory: --local requires a directory argument");
					return 1;
				}
			}
			const { spec, added } = await runInstall(configPath, { local });
			console.log(
				added
					? `Added "${spec}" to plugins in ${configPath}`
					: `Already present: "${spec}" in ${configPath} — no change`,
			);
			return 0;
		}

		if (command === "uninstall") {
			const { removed } = runUninstall(configPath);
			if (removed > 0) {
				console.log(`Removed ${removed} oc2-memory entr${removed === 1 ? "y" : "ies"} from ${configPath}`);
			} else {
				console.log(`No oc2-memory entry found in ${configPath}`);
			}
			console.log("Note: the package itself remains under ~/.cache/opencode/npm/ — OpenCode does not clear it.");
			return 0;
		}

		if (command === "status") {
			printStatus(await runStatus(configPath));
			return 0;
		}

		console.log(USAGE);
		return command ? 1 : 0;
	} catch (err) {
		console.error(`oc2-memory: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

const isDirectRun = (() => {
	try {
		return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err) => {
			console.error(`oc2-memory: ${err instanceof Error ? err.message : String(err)}`);
			process.exitCode = 1;
		});
}
