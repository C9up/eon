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

import type { EonConfig, EonConnectionConfig } from "./connection/config.js";
import type { EonConnection } from "./connection/EonConnection.js";
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
	};
	config: { get<T = unknown>(key: string): T | undefined };
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

	constructor(app: EonAppContext, connect: EonConnector = connectWsEon) {
		this.#app = app;
		this.#connect = connect;
	}

	register(): void {}

	async boot(): Promise<void> {
		if (this.#booted) {
			throw new Error(
				"EonProvider: boot() has already opened connections; a second boot would overwrite and leak them. Call shutdown() first, or construct a new provider.",
			);
		}
		// The compiler is transport-independent — register it unconditionally.
		const service: EonService = {
			compile: (spec, dialect) => compileStatementNative(spec, dialect),
		};
		this.#app.container.singleton("eon.compiler", () => service);

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
			entries.map(([, settings]) => this.#connect(settings)),
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
		this.#app.container.singleton("eon", () => defaultConn);
		this.#app.container.singleton("eon.connection", () => defaultConn);

		// Populate the `@c9up/eon/services/connection` singleton so apps can
		// `import connection from '@c9up/eon/services/connection'` anywhere. Lazy
		// import so a type-only discovery scan does not pull the module at
		// construction time.
		const { setConnection } = await import("./services/connection.js");
		setConnection(defaultConn);
		this.#booted = true;
	}

	async shutdown(): Promise<void> {
		// Close every connection in parallel. `allSettled` (fail-open) so a single
		// stuck close doesn't block the rest, but failures are aggregated and
		// rethrown so supervisors see a non-zero shutdown signal. The map + module
		// singleton are cleared unconditionally (never hand out closed handles).
		const named = [...this.#connections.entries()];
		const results = await Promise.allSettled(named.map(([, c]) => c.close()));
		this.#connections.clear();
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
