/**
 * Default `connection` singleton — ergonomic access to the configured eon
 * connection from anywhere, mirroring `@c9up/atlas/services/db`.
 *
 *   import connection from '@c9up/eon/services/connection'
 *
 *   const rows = await connection.query('SELECT server_version()')
 *
 * Populated by `EonProvider.boot()`. The instance is whatever
 * `timeseries.connections[default]` resolves to — a ws `EonConnection` today, a
 * future native impl behind the same seam tomorrow.
 */

import type {
	EonColumnarIngest,
	EonConnection,
	EonSchemalessOptions,
} from "../connection/EonConnection.js";

let instance: EonConnection | undefined;

/** @internal Bind the singleton (called by EonProvider.boot). */
export function setConnection(connection: EonConnection): void {
	instance = connection;
}

/**
 * @internal Unbind the singleton IF it still points at `connection` (called by
 * EonProvider.shutdown). Ownership-guarded: when a second provider rebound the
 * singleton, an older provider's shutdown must not clear the newer binding —
 * otherwise `connection.*` after shutdown would dereference a closed handle.
 */
export function clearConnection(connection: EonConnection): void {
	if (instance === connection) instance = undefined;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getConnection(): EonConnection | undefined {
	return instance;
}

/** The bound connection, or a descriptive throw if accessed before boot. */
function requireInstance(): EonConnection {
	if (!instance) {
		throw new Error(
			"[eon] connection singleton accessed before EonProvider.boot() ran. " +
				"Check that `@c9up/eon/provider` is listed in your reamrc.ts providers " +
				"and that `config/timeseries.ts` defines at least one connection.",
		);
	}
	return instance;
}

/**
 * Forwards each `EonConnection` member to the bound instance (throwing until
 * boot binds it). A plain forwarding object rather than a `Proxy` keeps the
 * generic `query<T>` typed and cast-free (AC9) — the seam surface is small and
 * explicit.
 */
const connection: EonConnection = {
	get transport() {
		return requireInstance().transport;
	},
	exec(sql: string): Promise<{ rowsAffected: number }> {
		return requireInstance().exec(sql);
	},
	query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
		return requireInstance().query<T>(sql);
	},
	ping(): Promise<void> {
		return requireInstance().ping();
	},
	ingestColumnar(
		request: EonColumnarIngest,
	): Promise<{ rowsAffected: number }> {
		return requireInstance().ingestColumnar(request);
	},
	schemaless(
		lines: readonly string[],
		options?: EonSchemalessOptions,
	): Promise<void> {
		return requireInstance().schemaless(lines, options);
	},
	close(): Promise<void> {
		return requireInstance().close();
	},
};

export default connection;
