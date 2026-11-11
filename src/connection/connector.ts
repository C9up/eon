/**
 * The one place eon loads `@tdengine/websocket`. Everything else imports the
 * connector from here (types may still come straight from the package).
 *
 * The connector changes the whole process when it loads, which a library must
 * not do — the host decides how the process crashes and shuts down:
 *
 * - `lib/src/common/log.js` builds a winston logger whose only transport is a
 *   `DailyRotateFile` on `./logs/app-%DATE%.log` with `handleExceptions: true`
 *   and `exitOnError: false`. Constructing it creates `./logs` in the cwd (an
 *   import fails outright on a read-only filesystem), and the exception handler
 *   swallows every uncaught exception and rejection into that file: the process
 *   keeps running and nothing reaches stderr.
 * - `lib/src/client/wsConnectorPool.js` registers SIGINT, SIGTERM and `exit`
 *   handlers that call `process.exit()` synchronously, cutting off the host's
 *   graceful shutdown and turning a SIGTERM into exit code 0.
 *
 * So the connector is required on first use, never at import, and
 * synchronously, with its file transport swapped for a silent one, and every
 * process listener it added is removed right after. Synchronous on purpose: nothing else can run between the snapshot and
 * the cleanup, so the listeners removed are exactly the connector's. Its pool
 * teardown is not lost: `destroyEonConnector()` runs it on eon's own shutdown.
 */

import type { EventEmitter } from "node:events";
import { createRequire, Module } from "node:module";
import { Writable } from "node:stream";
import type * as Tdengine from "@tdengine/websocket";

const PROCESS_EVENTS = [
	"uncaughtException",
	"uncaughtExceptionMonitor",
	"unhandledRejection",
	"SIGINT",
	"SIGTERM",
	"exit",
	"beforeExit",
] as const;

type ProcessEvent = (typeof PROCESS_EVENTS)[number];

/**
 * Stands in for `winston-daily-rotate-file`: an object-mode stream that
 * discards every record. It never sets `handleExceptions`, so winston does not
 * even install its exception handler.
 */
class SilentTransport extends Writable {
	level: string | undefined;

	constructor() {
		super({ objectMode: true });
	}

	override _write(
		_chunk: unknown,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		callback();
	}

	// winston's `add()` inspects `log.length` to decide whether to wrap a
	// legacy transport; two parameters keeps this one piped as a stream.
	log(_info: unknown, callback?: () => void): void {
		callback?.();
	}
}

type Listener = (...args: unknown[]) => void;

function isListener(value: unknown): value is Listener {
	return typeof value === "function";
}

// Typed as a plain emitter so one loop covers signals and process events alike.
const processEmitter: EventEmitter = process;

function listenersOf(event: ProcessEvent): Listener[] {
	return processEmitter.rawListeners(event).filter(isListener);
}

function loadConnector(): typeof Tdengine {
	const require = createRequire(import.meta.url);
	const entry = require.resolve("@tdengine/websocket");
	if (require.cache[entry] !== undefined) {
		// Already loaded by someone else: its side effects are in place and no
		// longer attributable. Nothing to swap.
		return require("@tdengine/websocket");
	}

	const transportPath = createRequire(entry).resolve(
		"winston-daily-rotate-file",
	);
	const previousTransport = require.cache[transportPath];
	const stub = new Module(transportPath);
	stub.filename = transportPath;
	stub.loaded = true;
	stub.exports = SilentTransport;
	require.cache[transportPath] = stub;

	const before = new Map(
		PROCESS_EVENTS.map((event) => [event, new Set(listenersOf(event))]),
	);
	try {
		return require("@tdengine/websocket");
	} finally {
		for (const [event, existing] of before) {
			for (const listener of listenersOf(event)) {
				if (!existing.has(listener)) {
					processEmitter.removeListener(event, listener);
				}
			}
		}
		if (previousTransport === undefined) delete require.cache[transportPath];
		else require.cache[transportPath] = previousTransport;
	}
}

let loaded: typeof Tdengine | undefined;

/**
 * The connector, loaded on the first call rather than when this module is
 * evaluated: importing `@c9up/eon` or its provider opens no socket, so a
 * fake-only boot, a provider inspection or a migration file pays nothing for
 * the driver. Every call after the first returns the same module.
 */
export function tdengine(): typeof Tdengine {
	loaded ??= loadConnector();
	return loaded;
}

/** Whether eon has loaded the connector, asked without loading it. */
export function isConnectorLoaded(): boolean {
	return loaded !== undefined;
}
