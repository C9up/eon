import { afterEach, describe, expect, it } from "vitest";
import type { EonConnection } from "../src/connection/EonConnection.js";
import {
	type CompiledStatement,
	type EonAppContext,
	type EonConfig,
	type EonConnector,
	EonProvider,
	type EonService,
} from "../src/index.js";
import { getConnection } from "../src/services/connection.js";

/**
 * Minimal structural app context — a fake container + config, no framework.
 *
 * `config.get<T>` is a generic getter over concrete data: satisfying that
 * signature requires one assertion at the variance boundary (the real ream
 * ConfigProvider and atlas's own test fake do the identical thing). Everything
 * else stays cast-free.
 */
function makeContext(
	config: Partial<Record<"eon" | "timeseries", EonConfig>>,
): {
	ctx: EonAppContext;
	registry: Map<string, () => unknown>;
} {
	const registry = new Map<string, () => unknown>();
	// Overloaded signature (generic out) + non-generic impl (returns `unknown`)
	// satisfies the generic `config.get<T>` seam with NO `as` cast — the same
	// trick the real `websocket.ts` uses for `query<T>` (AC10: no `as`).
	function configGet<T = unknown>(key: string): T | undefined;
	function configGet(key: string): unknown {
		return key === "eon"
			? config.eon
			: key === "timeseries"
				? config.timeseries
				: undefined;
	}
	const ctx: EonAppContext = {
		container: {
			singleton(token, factory) {
				registry.set(String(token), factory);
			},
		},
		config: { get: configGet },
	};
	return { ctx, registry };
}

function isEonService(value: unknown): value is EonService {
	return (
		typeof value === "object" &&
		value !== null &&
		"compile" in value &&
		typeof value.compile === "function"
	);
}

/** A fake `EonConnection` that records how many times it was closed. */
function makeFakeConnection(): {
	conn: EonConnection;
	closeCount: () => number;
} {
	let closed = 0;
	const conn: EonConnection = {
		transport: "websocket",
		exec() {
			return Promise.resolve({ rowsAffected: 0 });
		},
		query() {
			return Promise.resolve([]);
		},
		ping() {
			return Promise.resolve();
		},
		ingestColumnar() {
			return Promise.resolve({ rowsAffected: 0 });
		},
		schemaless() {
			return Promise.resolve();
		},
		close() {
			closed += 1;
			return Promise.resolve();
		},
	};
	return { conn, closeCount: () => closed };
}

/** A connector that hands out pre-built connections keyed by URL, recording calls. */
function makeConnector(byUrl: Record<string, EonConnection>): {
	connect: EonConnector;
	urls: () => string[];
} {
	const seen: string[] = [];
	const connect: EonConnector = (config) => {
		seen.push(config.url);
		const conn = byUrl[config.url];
		if (!conn) {
			return Promise.reject(
				new Error(`no fake connection for '${config.url}'`),
			);
		}
		return Promise.resolve(conn);
	};
	return { connect, urls: () => seen };
}

describe("EonProvider", () => {
	afterEach(async () => {
		// Release the module-level singleton any test may have bound.
		const bound = getConnection();
		if (bound) {
			const { clearConnection } = await import("../src/services/connection.js");
			clearConnection(bound);
		}
	});

	it("registers a working compiler under `eon.compiler` and opens no connection when config is absent", async () => {
		const { ctx, registry } = makeContext({});
		const { connect, urls } = makeConnector({});
		await new EonProvider(ctx, connect).boot();

		expect(urls()).toEqual([]); // connector never called without config
		expect(registry.has("eon")).toBe(false);
		expect([...registry.keys()].some((k) => k.startsWith("eon:"))).toBe(false);

		const service = registry.get("eon.compiler")?.();
		expect(isEonService(service)).toBe(true);
		if (!isEonService(service)) return;
		const compiled: CompiledStatement = service.compile({
			kind: "select",
			table: "meters",
			select: ["ts"],
			limit: 1,
		});
		expect(compiled.statements).toEqual(["SELECT `ts` FROM `meters` LIMIT 1"]);
	});

	it("opens the single connection and registers eon / eon.connection / eon:primary + the services singleton", async () => {
		const { conn } = makeFakeConnection();
		const { ctx, registry } = makeContext({
			eon: { url: "ws://localhost:6041" },
		});
		const { connect, urls } = makeConnector({ "ws://localhost:6041": conn });
		await new EonProvider(ctx, connect).boot();

		expect(urls()).toEqual(["ws://localhost:6041"]);
		expect(registry.get("eon")?.()).toBe(conn);
		expect(registry.get("eon.connection")?.()).toBe(conn);
		expect(registry.get("eon:primary")?.()).toBe(conn);
		expect(getConnection()).toBe(conn);
	});

	it("registers each named connection and the configured default under `eon`", async () => {
		const primary = makeFakeConnection().conn;
		const secondary = makeFakeConnection().conn;
		const { ctx, registry } = makeContext({
			timeseries: {
				url: "ws://ignored",
				default: "secondary",
				connections: {
					primary: { url: "ws://a:6041" },
					secondary: { url: "ws://b:6041" },
				},
			},
		});
		const { connect } = makeConnector({
			"ws://a:6041": primary,
			"ws://b:6041": secondary,
		});
		await new EonProvider(ctx, connect).boot();

		expect(registry.get("eon:primary")?.()).toBe(primary);
		expect(registry.get("eon:secondary")?.()).toBe(secondary);
		expect(registry.get("eon")?.()).toBe(secondary);
		expect(registry.get("eon.connection")?.()).toBe(secondary);
		expect(getConnection()).toBe(secondary);
	});

	it("closes already-opened connections and throws when one connection fails to open", async () => {
		const { conn: good, closeCount } = makeFakeConnection();
		const { ctx } = makeContext({
			timeseries: {
				url: "ws://ignored",
				connections: {
					good: { url: "ws://good:6041" },
					bad: { url: "ws://bad:6041" }, // no fake → connector rejects
				},
			},
		});
		const { connect } = makeConnector({ "ws://good:6041": good });

		await expect(new EonProvider(ctx, connect).boot()).rejects.toThrow(
			/failed to open 1 connection/,
		);
		expect(closeCount()).toBe(1); // the opened one was rolled back
		expect(getConnection()).toBeUndefined();
	});

	it("closes every opened connection and throws when the default name is missing", async () => {
		const { conn: a, closeCount: closeA } = makeFakeConnection();
		const { conn: b, closeCount: closeB } = makeFakeConnection();
		const { ctx } = makeContext({
			timeseries: {
				url: "ws://ignored",
				default: "nonexistent",
				connections: {
					reader: { url: "ws://r:6041" },
					writer: { url: "ws://w:6041" },
				},
			},
		});
		const { connect } = makeConnector({
			"ws://r:6041": a,
			"ws://w:6041": b,
		});
		await expect(new EonProvider(ctx, connect).boot()).rejects.toThrow(
			/default connection 'nonexistent' is not defined/,
		);
		// Both opened sockets rolled back — no leak on the default-missing path.
		expect(closeA()).toBe(1);
		expect(closeB()).toBe(1);
		expect(getConnection()).toBeUndefined();
	});

	it("exposes a default export for ream's provider loader (atlas parity)", async () => {
		const mod = await import("../src/EonProvider.js");
		expect(mod.default).toBe(EonProvider);
	});

	it("creates the database before opening the connection that selects it", async () => {
		// The whole point of `createDatabase`: a TDengine database nothing else
		// creates (no `POSTGRES_DB` equivalent) must exist before the connection
		// naming it can be opened, or the migration that would create it can
		// never run.
		const { conn } = makeFakeConnection();
		const opened: Array<string | undefined> = [];
		const statements: string[] = [];
		const recording: EonConnection = {
			...conn,
			exec(sql) {
				statements.push(sql);
				return Promise.resolve({ rowsAffected: 0 });
			},
		};
		const connect: EonConnector = (config) => {
			opened.push(config.database);
			return Promise.resolve(recording);
		};
		const { ctx } = makeContext({
			timeseries: {
				url: "ws://localhost:6041",
				database: "qwalto",
				createDatabase: { precision: "ms" },
			},
		});
		const provider = new EonProvider(ctx, connect);
		await provider.boot();

		// First without the database, to create it; then with it.
		expect(opened).toEqual([undefined, "qwalto"]);
		expect(statements).toEqual([
			"CREATE DATABASE IF NOT EXISTS `qwalto` PRECISION 'ms'",
		]);
		await provider.shutdown();
	});

	it("opens a single connection when no database bootstrap was asked for", async () => {
		const { conn } = makeFakeConnection();
		const opened: Array<string | undefined> = [];
		const connect: EonConnector = (config) => {
			opened.push(config.database);
			return Promise.resolve(conn);
		};
		const { ctx } = makeContext({
			timeseries: { url: "ws://localhost:6041", database: "qwalto" },
		});
		const provider = new EonProvider(ctx, connect);
		await provider.boot();
		expect(opened).toEqual(["qwalto"]);
		await provider.shutdown();
	});

	it("shutdown closes every connection and clears the services singleton", async () => {
		const { conn, closeCount } = makeFakeConnection();
		const { ctx } = makeContext({ eon: { url: "ws://localhost:6041" } });
		const { connect } = makeConnector({ "ws://localhost:6041": conn });
		const provider = new EonProvider(ctx, connect);
		await provider.boot();
		expect(getConnection()).toBe(conn);

		await provider.shutdown();
		expect(closeCount()).toBe(1);
		expect(getConnection()).toBeUndefined();
	});
});
