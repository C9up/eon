/**
 * Importing `@c9up/eon` must not change how the process crashes or shuts down.
 *
 * `@tdengine/websocket` 3.5.0 installs process-wide handlers when it loads: a
 * winston `uncaughtException` handler that logs to `./logs/app-*.log` and does
 * not exit, and SIGTERM / SIGINT / exit handlers that call `process.exit()`
 * synchronously. Each case runs in a child process with a fresh, empty cwd —
 * the runner's own process is not the thing under test.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tsxNode } from "./fixtures/tsxNode.js";

const script = fileURLToPath(
	new URL("./fixtures/connector-side-effects.ts", import.meta.url),
);

interface ChildResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	cwd: string;
}

const cwds: string[] = [];

afterEach(() => {
	for (const dir of cwds.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function run(mode: string): Promise<ChildResult> {
	const cwd = mkdtempSync(path.join(tmpdir(), "eon-side-effects-"));
	cwds.push(cwd);
	return new Promise((resolve, reject) => {
		const { command, args } = tsxNode(script, [mode]);
		const child = spawn(command, args, { cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`child '${mode}' did not exit; stdout=${stdout}`));
		}, 20_000);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, cwd });
		});
	});
}

describe("importing @c9up/eon does not load the connector", () => {
	// A fake-only boot, a provider inspection or a migration file importing the
	// barrel opens no socket, so it must not pay for loading the driver (and
	// winston behind it) either. The driver loads on the first connect.
	it("leaves @tdengine/websocket unloaded after importing the barrel, the provider and the tmq path", async () => {
		const result = await run("loaded");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const parsed: unknown = JSON.parse(result.stdout.trim());
		expect(parsed).toEqual({ loaded: false });
	}, 30_000);
});

describe("loading the connector", () => {
	// The connector's tree carries moment (GHSA-4p3w-j4w9-5jqw below 2.31.0)
	// through winston-daily-rotate-file and moment-timezone. The rotating file
	// transport is replaced by a silent one before the connector loads, and the
	// connector itself never requires moment-timezone, so moment never runs.
	// Dropping that swap would bring it back; this says so.
	it("never loads moment or moment-timezone", async () => {
		const result = await run("modules");
		expect(result.code).toBe(0);
		const parsed: unknown = JSON.parse(result.stdout.trim());
		expect(parsed).toEqual({ moment: [] });
	}, 30_000);
});

describe("importing @c9up/eon leaves the process semantics alone", () => {
	it("adds no process-wide listener", async () => {
		const result = await run("listeners");
		expect(result.code).toBe(0);
		const parsed: unknown = JSON.parse(result.stdout.trim());
		expect(parsed).toHaveProperty("before");
		expect(parsed).toHaveProperty("after");
		if (typeof parsed !== "object" || parsed === null)
			throw new Error("bad output");
		expect(Reflect.get(parsed, "after")).toEqual(Reflect.get(parsed, "before"));
	}, 30_000);

	it("still crashes with code 1 and the stack on stderr on an uncaught exception", async () => {
		const result = await run("throw");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("boom after importing eon");
		expect(result.stdout).not.toContain("STILL ALIVE");
	}, 30_000);

	it("still crashes on an unhandled rejection", async () => {
		const result = await run("reject");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("rejected after importing eon");
		expect(result.stdout).not.toContain("STILL ALIVE");
	}, 30_000);

	// Windows has no POSIX signals: `process.kill(pid, "SIGTERM")` terminates the
	// process outright and no SIGTERM listener ever runs, so there is no drain to
	// observe there. The test is not declared on Windows rather than skipped: CI
	// fails any skipped test, since a skip usually means the native binary did
	// not load.
	if (process.platform !== "win32") {
		it("lets the application's SIGTERM handler drain and pick the exit code", async () => {
			const result = await run("sigterm");
			expect(result.stdout).toContain("drained");
			expect(result.code).toBe(143);
		}, 30_000);
	}

	it("writes no ./logs directory into the working directory", async () => {
		const result = await run("throw");
		expect(existsSync(path.join(result.cwd, "logs"))).toBe(false);
	}, 30_000);
});
