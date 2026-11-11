/**
 * Imports `@c9up/eon` in a fresh process and then does one thing the process's
 * crash and shutdown semantics decide (see `connector-side-effects.test.ts`).
 * The mode is the first argument.
 */
import { createRequire } from "node:module";
import { sep } from "node:path";

const mode = process.argv[2];

const events = [
	"uncaughtException",
	"unhandledRejection",
	"SIGTERM",
	"SIGINT",
	"exit",
] as const;

function counts(): Record<string, number> {
	return Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
}

const before = counts();
await import("../../src/index.js");
if (mode !== "loaded") {
	// The connector loads on the first connect, not at import: load it the way
	// that connect does, so these modes check what loading it leaves behind.
	const { tdengine } = await import("../../src/connection/connector.js");
	tdengine();
}
const after = counts();

if (mode === "loaded") {
	await import("../../src/EonProvider.js");
	await import("../../src/tmq/index.js");
	const cache = createRequire(import.meta.url).cache;
	const loaded = Object.keys(cache).some((key) =>
		key.includes(`${sep}@tdengine${sep}`),
	);
	process.stdout.write(`${JSON.stringify({ loaded })}\n`);
} else if (mode === "listeners") {
	process.stdout.write(`${JSON.stringify({ before, after })}\n`);
} else if (mode === "throw") {
	setTimeout(() => {
		throw new Error("boom after importing eon");
	}, 10);
	setTimeout(() => {
		process.stdout.write("STILL ALIVE\n");
	}, 500);
} else if (mode === "reject") {
	void Promise.reject(new Error("rejected after importing eon"));
	setTimeout(() => {
		process.stdout.write("STILL ALIVE\n");
	}, 500);
} else if (mode === "sigterm") {
	process.on("SIGTERM", () => {
		setTimeout(() => {
			process.stdout.write("drained\n");
			process.exit(143);
		}, 100);
	});
	process.kill(process.pid, "SIGTERM");
	// Keep the loop alive for the handler's drain; the handler decides the exit.
	setTimeout(() => {}, 5_000);
} else {
	throw new Error(`unknown mode '${String(mode)}'`);
}
