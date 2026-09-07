/**
 * EonProvider — Ream provider for the Eon time-series layer.
 *
 * On boot it opens the configured ws-first TDengine connection(s) via
 * `connectWsEon` and registers them in the container (`eon` / `eon.connection`
 * / `eon:<name>`), plus the module-level `services/connection` singleton. The
 * transport-independent compiler is registered under `eon.compiler`. Shutdown
 * closes every connection (fail-open) and releases the singletons.
 *
 * Agnostic leaf: consumes the host framework's app context STRUCTURALLY — it
 * never imports `@c9up/ream`. Any context exposing `config.get(key)` and
 * `container.singleton(token, factory)` satisfies the contract.
 */

import "./augmentations.js";
import type { EonConfig, EonConnectionConfig } from "./connection/config.js";
import type { EonConnection } from "./connection/EonConnection.js";
import { ensureDatabase } from "./connection/ensureDatabase.js";
import { connectWsEon } from "./connection/websocket.js";
import {
	type CompiledStatement,
	compileStatementNative,
	type EonDialect,
} from "./query/native.js";

/**
 * Structural slice of the host framework's app context — only the surface
 * EonProvider uses. Mirrors atlas `AtlasAppContext`. The `token` type mirrors
 * ream's `ServiceToken` union so this can grow into Symbol/ctor tokens without
 * re-coupling to `@c9up/ream`; EonProvider uses `string` tokens today.
 */
export interface EonAppContext {
	container: {
		singleton(
			token: string | symbol | (new (...args: never[]) => unknown),
			factory: () => unknown,
		): void;
		/**
		 * Optional reader — present on ream's real container. Used to look up the
		 * `migrations` registry so `ream migrate` can drive eon without naming it.
		 * Structural, async-capable, like the binder above.
		 */
		resolve?(
			token: string | symbol | (new (...args: never[]) => unknown),
		): unknown | Promise<unknown>;
	};
	config: { get<T = unknown>(key: string): T | undefined };
	/**
	 * Optional reader — present on ream's real application.
	 *
	 * `'warmup'` means the application was assembled to be INSPECTED rather than
	 * run: a route listing, a codegen pass, a config dump. Providers register,
	 * boot and start on that path too, so anything that opens a socket or
	 * creates a database has to ask first. A host that does not implement it is
	 * treated as running.
	 */
	getMode?(): string;
}

/**
 * The transport-independent compiler service registered under `eon.compiler`.
 */
export interface EonService {
	compile(spec: object, dialect?: EonDialect): CompiledStatement;
}

/**
 * How EonProvider opens a connection. Defaults to `connectWsEon`; tests inject a
 * fake so the boot/shutdown wiring is exercised without a live TDengine server
 * (eon has no in-process transport, unlike atlas's sqlite).
 */
export type EonConnector = (
	config: EonConnectionConfig,
) => Promise<EonConnection>;

export class EonProvider {
	readonly #app: EonAppContext;
	readonly #connect: EonConnector;
	/** connection name → open connection. Populated at boot. */
	readonly #connections = new Map<string, EonConnection>();
	/** Set once a full boot opened connections — guards against a leaking re-boot. */
	#booted = false;
	/** What the `eon` / `eon.connection` tokens resolve to, once boot opened it. */
	#defaultConnection?: EonConnection;

	constructor(app: EonAppContext, connect: EonConnector = connectWsEon) {
		this.#app = app;
		this.#connect = connect;
	}

	register(): void {
		// Bindings belong here, not in boot(). Upstream registers in `register`
		// precisely so another provider can count on them during its own boot;
		// bound in boot, the container had a different surface depending on
		// which provider ran first, and `eon.compiler` was simply unavailable to
		// anything booting earlier.
		//
		// It is also pure — a compile is a call into the native compiler, no
		// socket, no database — so there is nothing here an inspection must
		// avoid.
		const service: EonService = {
			compile: (spec, dialect) => compileStatementNative(spec, dialect),
		};
		this.#app.container.singleton("eon.compiler", () => service);

		// The connection tokens are registered here too, so the surface does not
		// change between warmup and run. What they RESOLVE to still depends on
		// boot having opened something — a lazy factory cannot await — so
		// reading one too early says what to do instead of answering undefined.
		this.#app.container.singleton("eon", () => this.#requireDefault("eon"));
		this.#app.container.singleton("eon.connection", () =>
			this.#requireDefault("eon.connection"),
		);
	}

	/**
	 * The default connection, or a message naming what is missing.
	 *
	 * Resolving to `undefined` sent the caller into a `TypeError` several
	 * frames away from the cause — a provider that resolved eon during its own
	 * boot, or an application with no `config/timeseries.ts` at all.
	 */
	#requireDefault(token: string): EonConnection {
		const connection = this.#defaultConnection;
		if (connection === undefined) {
			throw new Error(
				`EonProvider: '${token}' was resolved before any connection was opened. Connections open in boot(); check that config.timeseries defines one and that EonProvider is listed before whatever resolved this.`,
			);
		}
		return connection;
	}

	/** True when the application was assembled to be inspected rather than run. */
	#isInspecting(): boolean {
		return this.#app.getMode?.() === "warmup";
	}

	async boot(): Promise<void> {
		// An inspection opens no WebSocket and creates no database. `warmUp()`
		// runs boot, so a route listing reached TDengine — and could CREATE a
		// database there — while `shutdown()` never fires on that path, leaving
		// the sockets open. The compiler binding below is pure and stays.
		if (this.#booted) {
			throw new Error(
				"EonProvider: boot() has already opened connections; a second boot would overwrite and leak them. Call shutdown() first, or construct a new provider.",
			);
		}
		// Everything here opens a socket or creates a database, so an
		// inspection stops at the compiler. `warmUp()` runs boot, so a route
		// listing reached TDengine — and could CREATE a database there — while
		// `shutdown()` never fires on that path, leaving the sockets open.
		if (this.#isInspecting()) return;

		const config =
			this.#app.config.get<EonConfig>("timeseries") ??
			this.#app.config.get<EonConfig>("eon");
		if (!config) return;

		const { connections, defaultName } = this.#resolveConnections(config);

		// Open every connection in parallel. `allSettled` lets us distinguish
		// successes from failures without leaking the already-opened ones: on any
		// failure we close every success before rethrowing (no partial-boot leak).
		const entries = Object.entries(connections);
		const results = await Promise.allSettled(
			entries.map(([, settings]) => this.#openConnection(settings)),
		);
		const failures: Array<{ name: string; error: unknown }> = [];
		const successes: Array<{ name: string; conn: EonConnection }> = [];
		results.forEach((result, i) => {
			const entry = entries[i];
			if (!entry) return; // unreachable — allSettled preserves length/order
			const [name] = entry;
			if (result.status === "fulfilled") {
				successes.push({ name, conn: result.value });
			} else {
				failures.push({ name, error: result.reason });
			}
		});
		const first = failures[0];
		if (first) {
			await Promise.allSettled(successes.map((s) => s.conn.close()));
			const others = failures
				.slice(1)
				.map((f) => `${f.name}: ${String(f.error)}`)
				.join("; ");
			throw new Error(
				`EonProvider: failed to open ${failures.length} connection(s) — ` +
					`'${first.name}' failed: ${String(first.error)}` +
					(others ? ` (also: ${others})` : ""),
			);
		}

		for (const { name, conn } of successes) {
			this.#connections.set(name, conn);
		}

		const defaultConn = this.#connections.get(defaultName);
		if (!defaultConn) {
			// Same rollback the connect-failure branch does above — close the
			// already-opened sockets before throwing, else they leak (and #booted
			// stays false, so a retry would open even more).
			await Promise.allSettled(
				[...this.#connections.values()].map((conn) => conn.close()),
			);
			this.#connections.clear();
			throw new Error(
				`EonProvider: default connection '${defaultName}' is not defined in config.timeseries.connections`,
			);
		}
		// Register the container singletons only AFTER validation succeeds. The
		// throw path above registers none, so a failed boot never leaves an
		// `eon:<name>` factory resolving to a now-closed connection.
		for (const { name, conn } of successes) {
			this.#app.container.singleton(`eon:${name}`, () => conn);
		}
		// `eon` and `eon.connection` were bound in register(); this is what they
		// resolve to.
		this.#defaultConnection = defaultConn;

		// Populate the `@c9up/eon/services/connection` singleton so apps can
		// `import connection from '@c9up/eon/services/connection'` anywhere. Lazy
		// import so a type-only discovery scan does not pull the module at
		// construction time.
		const { setConnection } = await import("./services/connection.js");
		setConnection(defaultConn);

		await this.#registerMigrationSource(defaultConn, config);
		this.#booted = true;
	}

	/**
	 * Hand eon's migration runner to the framework's `migrations` registry, so
	 * `ream migrate` drives it without the CLI knowing eon exists.
	 *
	 * Best-effort and duck-typed: eon does not import `@c9up/ream`, and a host
	 * with no registry (an older ream, or another framework) must still boot.
	 * The CLI is where a missing registry gets reported, because that is where
	 * the user can act on it.
	 */
	async #registerMigrationSource(
		conn: EonConnection,
		config: EonConfig,
	): Promise<void> {
		const resolve = this.#app.container.resolve;
		if (typeof resolve !== "function") return;

		let registry: unknown;
		try {
			registry = await resolve.call(this.#app.container, "migrations");
		} catch {
			return;
		}
		if (
			typeof registry !== "object" ||
			registry === null ||
			!("register" in registry) ||
			typeof registry.register !== "function"
		) {
			return;
		}

		const { EonMigrationRunner } = await import(
			"./schema/EonMigrationRunner.js"
		);
		const migrationsDir = config.migrationsDir ?? "database/eon-migrations";
		(registry.register as (source: unknown) => unknown)({
			name: "eon",
			directory: migrationsDir,
			runner: new EonMigrationRunner(conn, { migrationsDir }),
		});
	}

	async shutdown(): Promise<void> {
		// Close every connection in parallel. `allSettled` (fail-open) so a single
		// stuck close doesn't block the rest, but failures are aggregated and
		// rethrown so supervisors see a non-zero shutdown signal. The map + module
		// singleton are cleared unconditionally (never hand out closed handles).
		const named = [...this.#connections.entries()];
		const results = await Promise.allSettled(named.map(([, c]) => c.close()));
		this.#connections.clear();
		this.#defaultConnection = undefined;
		this.#booted = false; // allow a fresh boot() after a clean shutdown

		const { clearConnection } = await import("./services/connection.js");
		for (const [, conn] of named) clearConnection(conn);

		// Closing every connection is NOT enough to let Node exit: the connector
		// keeps process-global handles, so a service that shut down cleanly would
		// hang forever. Only for a real ws connection — a fake-only boot (tests)
		// must not pull the connector in. Dynamic import for the same reason.
		if (named.some(([, c]) => c.transport === "websocket")) {
			const { destroyEonConnector } = await import("./connection/websocket.js");
			await destroyEonConnector();
		}

		const errors = results
			.map((result, i) =>
				result.status === "rejected"
					? { name: named[i]?.[0] ?? "unknown", error: result.reason }
					: null,
			)
			.filter((x): x is { name: string; error: unknown } => x !== null);
		if (errors.length > 0) {
			const summary = errors
				.map((e) => `'${e.name}': ${String(e.error)}`)
				.join("; ");
			throw new AggregateError(
				errors.map((e) => e.error),
				`EonProvider: ${errors.length} connection(s) failed to close — ${summary}`,
			);
		}
	}

	/**
	 * Open one connection, creating its database first when the connection asked
	 * for it. Both steps go through the injected connector, so a fake exercises
	 * the bootstrap exactly like the real transport does.
	 */
	async #openConnection(settings: EonConnectionConfig): Promise<EonConnection> {
		await ensureDatabase(settings, this.#connect);
		return this.#connect(settings);
	}

	/** Normalize the config into a `{ name → EonConnectionConfig }` map + default name. */
	#resolveConnections(config: EonConfig): {
		connections: Record<string, EonConnectionConfig>;
		defaultName: string;
	} {
		if (config.connections && Object.keys(config.connections).length > 0) {
			return {
				connections: config.connections,
				defaultName: config.default ?? "primary",
			};
		}
		// Single-connection shape — promote to a one-entry map under "primary"
		// (mirror atlas: copy the connection fields, drop `default`/`connections`).
		return {
			connections: {
				primary: {
					url: config.url,
					user: config.user,
					password: config.password,
					database: config.database,
					createDatabase: config.createDatabase,
					token: config.token,
					timeoutMs: config.timeoutMs,
					connectRetries: config.connectRetries,
					connectBackoffMs: config.connectBackoffMs,
				},
			},
			defaultName: "primary",
		};
	}
}

// ream's provider loader constructs `new mod.default(app)` (atlas parity:
// `export default class AtlasProvider`). The named export stays for tests.
export default EonProvider;
