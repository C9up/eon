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

/**
 * A provider through its real lifecycle: `register()` then `boot()`.
 *
 * Bindings live in `register` now — upstream's placement, and what lets another
 * provider count on them during its own boot. A test that jumped straight to
 * `boot()` was exercising a sequence the framework never produces.
 */
function booted(provider: EonProvider): Promise<void> {
	provider.register();
	return provider.boot();
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

	it("opens no connection while the app is only being inspected", async () => {
		// `warmUp()` — what `ream inspect`, a route listing and a codegen pass
		// use — runs register, boot and start. Opening a WebSocket there made
		// every one of them need TDengine reachable, and `ensureDatabase` could
		// CREATE a database on a read-only command. `shutdown()` never fires on
		// that path either, so the sockets stayed open.
		const { conn } = makeFakeConnection();
		const { ctx, registry } = makeContext({
			// The same config the test below opens a connection from, so the two
			// differ only in the mode.
			eon: { url: "ws://localhost:6041" },
		});
		const { connect, urls } = makeConnector({ "ws://localhost:6041": conn });
		await booted(new EonProvider({ ...ctx, getMode: () => "warmup" }, connect));

		expect(urls()).toEqual([]);
		// The TOKEN exists — the container's surface must not depend on the mode
		// the application was assembled in. What it resolves to is another
		// matter: nothing was opened, so reading it says so.
		expect(registry.has("eon")).toBe(true);
		expect(() => registry.get("eon")?.()).toThrow(/before any connection/);
		// The compiler is pure, so it answers normally: a codegen pass is
		// exactly the caller that needs it.
		expect(registry.has("eon.compiler")).toBe(true);
	});

	it("registers a working compiler under `eon.compiler` and opens no connection when config is absent", async () => {
		const { ctx, registry } = makeContext({});
		const { connect, urls } = makeConnector({});
		await booted(new EonProvider(ctx, connect));

		expect(urls()).toEqual([]); // connector never called without config
		// Registered, and honest about having nothing behind it. Resolving to
		// `undefined` sent the caller into a TypeError several frames from the
		// cause — an application with no `config/timeseries.ts` at all.
		expect(registry.has("eon")).toBe(true);
		expect(() => registry.get("eon")?.()).toThrow(/before any connection/);
		// A NAMED connection is different: `eon:primary` exists only if primary
		// was configured, so there is nothing to bind ahead of time.
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
		await booted(new EonProvider(ctx, connect));

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
		await booted(new EonProvider(ctx, connect));

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

		await expect(booted(new EonProvider(ctx, connect))).rejects.toThrow(
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
		await expect(booted(new EonProvider(ctx, connect))).rejects.toThrow(
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
		provider.register();
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
		provider.register();
		await provider.boot();
		expect(opened).toEqual(["qwalto"]);
		await provider.shutdown();
	});

	it("shutdown closes every connection and clears the services singleton", async () => {
		const { conn, closeCount } = makeFakeConnection();
		const { ctx } = makeContext({ eon: { url: "ws://localhost:6041" } });
		const { connect } = makeConnector({ "ws://localhost:6041": conn });
		const provider = new EonProvider(ctx, connect);
		provider.register();
		await provider.boot();
		expect(getConnection()).toBe(conn);

		await provider.shutdown();
		expect(closeCount()).toBe(1);
		expect(getConnection()).toBeUndefined();
	});
});

/**
 * A boot that opened its connections and then failed must leave nothing.
 *
 * Everything after the sockets open — the container bindings, the module
 * singleton, the migration source — could throw with no rollback: the
 * connections stayed open, the singleton could stay published, and `#booted`
 * stayed false, so the next attempt opened another set on top of the ones
 * nobody could reach.
 */
describe("EonProvider rolls back a late boot failure", () => {
	it("closes the connections and unpublishes the singleton", async () => {
		const closed: string[] = [];
		const { conn } = makeFakeConnection();
		const original = conn.close.bind(conn);
		conn.close = async () => {
			closed.push("primary");
			return original();
		};
		const { ctx } = makeContext({
			timeseries: {
				url: "ws://ignored",
				default: "primary",
				connections: { primary: { url: "ws://localhost:6041" } },
			},
		});
		// A registry whose `register` throws — the last step of boot, and the
		// one most likely to fail against a host that changed.
		ctx.container.resolve = async (token: unknown) => {
			if (token === "migrations") {
				return {
					register() {
						throw new Error("registry refused the source");
					},
				};
			}
			return undefined;
		};
		const { connect } = makeConnector({ "ws://localhost:6041": conn });
		const provider = new EonProvider(ctx, connect);
		provider.register();

		await expect(provider.boot()).rejects.toThrow(/registry refused/);

		// The socket this attempt opened is closed, not leaked.
		expect(closed).toEqual(["primary"]);
		const { getConnection } = await import("../src/services/connection.js");
		expect(getConnection()).toBeUndefined();
	});
});

/**
 * A provider that stops has to give its migration name back.
 *
 * `register` refuses a duplicate name on purpose, so a shutdown that keeps its
 * registration leaves a second boot in the same process — a hot reload, a test
 * that restarts the app — failing on "already registered", with the CLI holding
 * a runner pointing at a connection that was closed.
 */
describe("EonProvider releases its migration source", () => {
	function registryStub() {
		const names: string[] = [];
		return {
			names,
			registry: {
				register(source: { name: string }) {
					if (names.includes(source.name)) {
						throw new Error(`'${source.name}' is already registered`);
					}
					names.push(source.name);
				},
				unregister(name: string) {
					const at = names.indexOf(name);
					if (at === -1) return false;
					names.splice(at, 1);
					return true;
				},
			},
		};
	}

	it("can boot, shut down and boot again in one process", async () => {
		const { conn } = makeFakeConnection();
		const { ctx } = makeContext({
			timeseries: {
				url: "ws://ignored",
				default: "primary",
				connections: { primary: { url: "ws://localhost:6041" } },
			},
		});
		const { names, registry } = registryStub();
		ctx.container.resolve = async (token: unknown) =>
			token === "migrations" ? registry : undefined;
		const { connect } = makeConnector({ "ws://localhost:6041": conn });

		const first = new EonProvider(ctx, connect);
		first.register();
		await first.boot();
		expect(names).toEqual(["eon"]);

		await first.shutdown();
		expect(names).toEqual([]);

		// The second boot is what used to fail on "already registered".
		const second = new EonProvider(ctx, connect);
		second.register();
		await expect(second.boot()).resolves.toBeUndefined();
		await second.shutdown();
	});
});

/**
 * The named tokens belong in `register()` too.
 *
 * Their names come from the config, and nothing about `eon:primary` needs a
 * socket to exist. Bound in boot they appeared only on the run path — so the
 * container had a different surface in an inspection — and a boot that failed
 * late left factories behind pointing at connections it had just closed.
 */
describe("EonProvider binds the named connections in register()", () => {
	const CONFIG = {
		url: "ws://ignored",
		default: "primary",
		connections: {
			primary: { url: "ws://localhost:6041" },
			replica: { url: "ws://replica:6041" },
		},
	};

	it("registers every configured name before anything opens", () => {
		const { ctx, registry } = makeContext({ timeseries: CONFIG });
		const { connect, urls } = makeConnector({});

		new EonProvider(ctx, connect).register();

		expect([...registry.keys()].sort()).toEqual(
			[
				"eon",
				"eon.compiler",
				"eon.connection",
				"eon:primary",
				"eon:replica",
			].sort(),
		);
		// And opened nothing doing it.
		expect(urls()).toEqual([]);
	});

	it("says what is missing when one is resolved too early", () => {
		const { ctx, registry } = makeContext({ timeseries: CONFIG });
		const { connect } = makeConnector({});
		new EonProvider(ctx, connect).register();

		expect(() => registry.get("eon:replica")?.()).toThrow(
			/before it was opened/,
		);
	});
});
