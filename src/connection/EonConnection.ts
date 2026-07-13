/**
 * `EonConnection` — the transport-agnostic seam every eon transport satisfies.
 *
 * The WebSocket implementation (`connectWsEon`) is ONE implementation. A
 * deferred native `taos` implementation (`connectNativeEon`, opt-in, a later
 * story — memory `project_eon_transport_decision`) satisfies this same
 * interface, and the locked columnar bulk-ingest STMT method (spike 58-0 AC4)
 * is added onto a live connection in story 58.4. Neither is built here, but the
 * seam must not preclude them — keep `exec`/`query`/`ping`/`close`
 * transport-neutral (no ws-specific type leaks through).
 *
 * `exec`/`query` take LITERAL SQL only. TDengine binds positional `?`
 * placeholders exclusively through the STMT path (58.4 ingest), so the 58.1
 * compiler's `params` array is NOT threaded through `exec`: a compiled
 * param-free statement runs as literal SQL, a parameterised one waits for STMT.
 */
export interface EonConnection {
	/**
	 * Which transport backs this connection. A future native impl reports
	 * `"native"`; the in-memory test double (`FakeEonConnection`, 58.6) reports
	 * `"fake"`.
	 */
	readonly transport: "websocket" | "native" | "fake";
	/** Run a literal DDL/DML statement (CREATE / USE / INSERT). */
	exec(sql: string): Promise<{ rowsAffected: number }>;
	/** Run a literal SELECT; rows are mapped to objects keyed by column name. */
	query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	/** Liveness probe — a cheap round-trip to the server. */
	ping(): Promise<void>;
	/**
	 * Columnar STMT bulk ingest (story 58.4) — the default high-throughput write
	 * path. Binds each child table's whole-column typed arrays once per batch
	 * through the transport's STMT2 API, so no per-row object crosses the
	 * boundary (the locked 58.0 columnar contract, kept even on the ws path).
	 *
	 * It lives on the connection — not as a free function — because only the
	 * transport owns the live STMT handle; the `transport` discriminant is a
	 * string, never the raw ws socket. A future native impl satisfies this same
	 * agnostic contract, so ingest code never imports a ws-specific type.
	 */
	ingestColumnar(request: EonColumnarIngest): Promise<{ rowsAffected: number }>;
	/**
	 * Schemaless line-protocol ingest (InfluxDB / OpenTSDB). A documented ~8–10×
	 * slower helper than STMT — NOT the default bulk path (AC4). Bypasses SQL
	 * entirely; the transport maps the agnostic protocol/precision to its native
	 * enums.
	 */
	schemaless(
		lines: readonly string[],
		options?: EonSchemalessOptions,
	): Promise<void>;
	/** Close THIS connection (never the process-global connector — D6). */
	close(): Promise<void>;
}

/**
 * How a bound column's values are typed for the STMT columnar bind path. Mirrors
 * the compiler's `ColumnTypeKind` (camelCase) so ingest code carries the column
 * metadata kind straight through; the transport maps each kind to its native
 * columnar setter. No ws-specific type leaks into this seam.
 */
export type EonBindKind =
	| "timestamp"
	| "bool"
	| "tinyInt"
	| "smallInt"
	| "int"
	| "bigInt"
	| "float"
	| "double"
	| "varchar"
	| "nchar"
	| "varbinary"
	| "json"
	| "decimal";

/**
 * One column's values in struct-of-arrays layout plus the kind that selects the
 * transport's typed setter. `values` holds the WHOLE column (N rows) for metric
 * columns, or a single-element array for a child's tag value.
 */
export interface EonBoundColumn {
	readonly kind: EonBindKind;
	readonly values: unknown[];
}

/** One child table's columnar batch: its name, tag values, and metric columns. */
export interface EonChildBatch {
	/** The (deterministic) child-table name bound via the STMT `?` table slot. */
	readonly table: string;
	/** Tag values (one single-element column per tag), bound before the columns. */
	readonly tags: readonly EonBoundColumn[];
	/** Value columns in prepared order (timestamp first); each holds the column. */
	readonly columns: readonly EonBoundColumn[];
}

/**
 * A columnar STMT bulk-ingest request: one prepared template reused across every
 * child batch. `sql` is the compiler-produced STMT template
 * (`INSERT INTO ? USING <stable> (…) TAGS (?) VALUES (?)`).
 */
export interface EonColumnarIngest {
	readonly sql: string;
	readonly children: readonly EonChildBatch[];
}

/** Line-protocol variants for the schemaless path. */
export type EonLineProtocol = "influxdb" | "opentsdb-telnet" | "opentsdb-json";

/** Timestamp precision for the schemaless path. */
export type EonSchemalessPrecision =
	| "hours"
	| "minutes"
	| "seconds"
	| "milliseconds"
	| "microseconds"
	| "nanoseconds";

/** Options for {@link EonConnection.schemaless}. */
export interface EonSchemalessOptions {
	/** Line-protocol variant. Default `"influxdb"`. */
	readonly protocol?: EonLineProtocol;
	/** Timestamp precision. Default `"milliseconds"`. */
	readonly precision?: EonSchemalessPrecision;
	/** Child-table TTL in days (0 = none). Default `0`. */
	readonly ttl?: number;
}

/**
 * Error thrown by an eon transport. When the failure originated in the TDengine
 * connector, `code` carries the connector's numeric error code verbatim (never
 * swallowed), so callers can branch on it.
 */
export class EonConnectionError extends Error {
	/** The underlying TDengine numeric error code, when the failure came from the connector. */
	readonly code?: number;

	constructor(message: string, options?: { cause?: unknown; code?: number }) {
		super(
			message,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "EonConnectionError";
		this.code = options?.code;
	}
}
