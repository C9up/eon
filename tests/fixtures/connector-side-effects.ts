/**
 * Imports `@c9up/eon` in a fresh process and then does one thing the process's
 * crash and shutdown semantics decide (see `connector-side-effects.test.ts`).
 * The mode is the first argument.
 */
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
const after = counts();

if (mode === "listeners") {
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
