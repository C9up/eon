/**
 * `SuperTableRepository<TPoint>` — the Atlas-shaped ingest API for a TDengine
 * super-table (story 58.4).
 *
 * Mirrors `@c9up/atlas` `BaseRepository` naming: `ingest` (≙ `create`) and
 * `ingestMany` (≙ `createMany`, the bulk primitive), plus two extra write paths
 * TDengine adds — `ingestSql` (literal INSERT) and `ingestSchemaless` (line
 * protocol). It deliberately OMITS everything TDengine has no analogue for
 * (AC8): no `save`/`upsert`/`firstOrCreate`, no `useTransaction`/BEGIN-COMMIT,
 * no `RETURNING`, no DB-generated-PK hydrate-back. TDengine writes are
 * append / last-write-wins by the caller-supplied timestamp.
 *
 * Schema is read ONLY through the 58.3 decorator metadata getters — never
 * `key in instance` (the `@Column() declare x` pitfall, memory
 * `project_atlas_declare_hydration`). The connection is injected structurally
 * (agnostic leaf, AD1 — no `@c9up/ream` import).
 */

import type {
	EonConnection,
	EonSchemalessOptions,
} from "../connection/EonConnection.js";
import {
	getColumnMetadata,
	getSuperTableMetadata,
	getTagMetadata,
	getTimestampColumn,
} from "../decorators/superTable.js";
import { toLineProtocol } from "../ingest/schemaless.js";
import { buildLiteralInserts } from "../ingest/sql.js";
import {
	buildColumnarIngest,
	type ColumnarPlan,
	compileStmtTemplate,
	DEFAULT_BATCH_SIZE,
	type IngestPoint,
	type PlanColumn,
	toBindKind,
} from "../ingest/stmt.js";
import { TimeSeriesQuery } from "../query/TimeSeriesQuery.js";
import {
	orderTimestampFirst,
	type SuperTableClass,
} from "../schema/compile.js";

/** Options for {@link SuperTableRepository}. */
export interface SuperTableRepositoryOptions {
	/** STMT chunk size (rows per child per bind). Default {@link DEFAULT_BATCH_SIZE}. */
	readonly batchSize?: number;
}

/**
 * Repository for a TDengine super-table — atlas `BaseRepository` parity for the
 * time-series model. NAMED deviation from atlas (prime directive: name any
 * divergence): atlas types reads by constructing `new Entity()` instances; eon
 * reads plain records and never constructs instances, so typed reads are opt-in
 * through `query(mapPoint)` — the caller supplies the row → `E` mapper, composed
 * on top of the bigint/timestamp-reviving base hydrator (no `as`, the decode
 * stays honest). Called without a mapper, points stay `Record<string, unknown>`.
 */
export class SuperTableRepository {
	readonly #conn: EonConnection;
	readonly #plan: ColumnarPlan;
	readonly #querySchema: QuerySchema;

	constructor(
		entityClass: SuperTableClass,
		conn: EonConnection,
		options?: SuperTableRepositoryOptions,
	) {
		// Fail loud on a null/undefined connection — almost always a failed IoC
		// injection (atlas `BaseRepository.ts:245` parity), not a runtime NPE later.
		if (conn === null || conn === undefined) {
			throw new Error(
				`[E_EON_MISSING_CONNECTION] SuperTableRepository for '${entityClass?.name ?? "<unknown entity>"}' requires an EonConnection (got ${conn === null ? "null" : "undefined"}). Check IoC constructor injection is wired.`,
			);
		}
		this.#conn = conn;
		this.#plan = buildPlan(entityClass, options);
		this.#querySchema = buildQuerySchema(entityClass);
	}

	/**
	 * A fluent time-series read builder bound to this repository's connection and
	 * the entity's 58.3 schema metadata. Rows hydrate through a metadata-driven
	 * closure — declared columns by their `@Column`/`@Tag` metadata (bigint /
	 * timestamp revived as `bigint`), NEVER `key in instance` (the `declare`-field
	 * pitfall), and window pseudo-columns / aggregate aliases attached raw.
	 *
	 * Pass `mapPoint` to project each decoded row into a typed `E` (atlas-parity
	 * typed reads, no `as`): the mapper composes on top of the base hydrator so
	 * bigint/timestamp revival still happens first. Without a mapper, points stay
	 * `Record<string, unknown>`.
	 */
	query(): TimeSeriesQuery<Record<string, unknown>>;
	query<E extends object>(
		mapPoint: (row: Record<string, unknown>) => E,
	): TimeSeriesQuery<E>;
	query<E extends object>(
		mapPoint?: (row: Record<string, unknown>) => E,
	): TimeSeriesQuery<E> | TimeSeriesQuery<Record<string, unknown>> {
		const base = this.#querySchema.hydrate;
		if (mapPoint) {
			return new TimeSeriesQuery(
				this.#querySchema.stable,
				this.#conn,
				(row) => mapPoint(base(row)),
				this.#querySchema.known,
			);
		}
		return new TimeSeriesQuery(
			this.#querySchema.stable,
			this.#conn,
			base,
			this.#querySchema.known,
		);
	}

	/** Ingest a single point (≙ atlas `create`). */
	async ingest(point: IngestPoint): Promise<void> {
		await this.ingestMany([point]);
	}

	/**
	 * Bulk ingest via the columnar STMT path (≙ atlas `createMany`) — the default
	 * high-throughput, injection-safe write. Groups by child table, binds SoA
	 * columns once per batch. Returns total rows affected. `async` so a plan
	 * error (e.g. an unsafe-integer timestamp) surfaces as a rejection, not a
	 * synchronous throw at the call site.
	 */
	async ingestMany(
		points: readonly IngestPoint[],
	): Promise<{ rowsAffected: number }> {
		if (points.length === 0) return { rowsAffected: 0 };
		this.#refuseDecimalOverStmt();
		return this.#conn.ingestColumnar(buildColumnarIngest(this.#plan, points));
	}

	/**
	 * Refuse the columnar path for a DECIMAL column.
	 *
	 * `@tdengine/websocket` 3.5.0 — the newest there is — binds DECIMAL through
	 * stmt2 as a variable-length column and the value lands in the row as raw
	 * adjacent memory: `'61.99'` into DECIMAL(20,10) read back as
	 * `-4268664320557975669762473403.2597208778`, and a different number on
	 * every run. Measured against a live server, and reproduced with the
	 * connector's own API and no eon code in the path, so there is nothing here
	 * to fix and no newer version to move to.
	 *
	 * A wrong price that inserts without complaint is the worst outcome
	 * available, so this path refuses and names the one that was measured exact.
	 * {@link ingestSql} renders the literal and lets the server parse it;
	 * {@link ingestSchemaless} already refuses a decimal on its own.
	 */
	#refuseDecimalOverStmt(): void {
		const decimals = this.#plan.columns
			.filter((c) => c.kind === "decimal")
			.map((c) => c.property);
		if (decimals.length === 0) return;
		throw new Error(
			`[E_EON_DECIMAL_STMT] super-table '${this.#plan.stable}' has DECIMAL column(s) ${decimals.join(", ")}, which the columnar STMT path cannot bind: ` +
				"@tdengine/websocket 3.5.0 stores an unrelated number instead of the value, without error. " +
				"Use ingestSql() for this super-table — it renders the literal and round-trips exactly.",
		);
	}

	/**
	 * Bulk ingest via literal SQL INSERT (AC5) — a convenience/fallback path run
	 * through `exec`. One `INSERT … USING … TAGS … VALUES` per child table; all
	 * value literals are rendered by the Rust compiler (no TS interpolation).
	 */
	async ingestSql(
		points: readonly IngestPoint[],
	): Promise<{ rowsAffected: number }> {
		if (points.length === 0) return { rowsAffected: 0 };
		let rowsAffected = 0;
		for (const sql of buildLiteralInserts(this.#plan, points)) {
			const result = await this.#conn.exec(sql);
			rowsAffected += result.rowsAffected;
		}
		return { rowsAffected };
	}

	/**
	 * Bulk ingest via schemaless line protocol (AC4) — a documented ~8–10× slower
	 * helper, NOT the default bulk path. Renders points to InfluxDB line protocol
	 * from the entity metadata and passes them to the transport.
	 */
	async ingestSchemaless(
		points: readonly IngestPoint[],
		options?: EonSchemalessOptions,
	): Promise<void> {
		if (points.length === 0) return;
		await this.#conn.schemaless(toLineProtocol(this.#plan, points), options);
	}
}

/** Resolve the immutable ingest plan from a decorated super-table class. */
function buildPlan(
	entityClass: SuperTableClass,
	options?: SuperTableRepositoryOptions,
): ColumnarPlan {
	const meta = getSuperTableMetadata(entityClass);
	if (!meta) {
		throw new Error(
			`[E_EON_NOT_A_SUPERTABLE] ${entityClass.name} is not decorated with @SuperTable`,
		);
	}
	const tsProperty = getTimestampColumn(entityClass);
	if (!tsProperty) {
		throw new Error(
			`[E_EON_NO_TIMESTAMP] super-table '${meta.name}' has no @Timestamp column`,
		);
	}

	const columnMeta = getColumnMetadata(entityClass);
	const tsColumn = columnMeta.find((c) => c.propertyKey === tsProperty);
	if (!tsColumn) {
		throw new Error(
			`[E_EON_NO_TIMESTAMP] super-table '${meta.name}' @Timestamp column '${tsProperty}' is not registered`,
		);
	}
	// Timestamp first, from the SAME shared ordering the STABLE was created with
	// (`orderTimestampFirst`), so the positional STMT bind lines up with the
	// STABLE's physical columns and can never drift.
	const ordered = orderTimestampFirst(columnMeta, tsColumn, tsProperty);
	const columns: PlanColumn[] = ordered.map((c) => ({
		property: c.propertyKey,
		kind: toBindKind(c.type, c.propertyKey),
	}));

	const tags: PlanColumn[] = getTagMetadata(entityClass).map((t) => ({
		property: t.propertyKey,
		kind: toBindKind(t.type, t.propertyKey),
	}));
	if (tags.length === 0) {
		throw new Error(
			`[E_EON_NO_TAGS] super-table '${meta.name}' has no @Tag columns; a child table cannot be routed without tags`,
		);
	}

	const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new Error(
			`[E_EON_BATCH_SIZE] batchSize must be a positive integer (got ${batchSize})`,
		);
	}

	const templateSql = compileStmtTemplate(
		meta.name,
		tags.map((t) => t.property),
		columns.map((c) => c.property),
	);

	return {
		stable: meta.name,
		templateSql,
		tsProperty,
		columns,
		tags,
		batchSize,
	};
}

/** The metadata a {@link TimeSeriesQuery} needs to hydrate rows into points. */
interface QuerySchema {
	/** The super-table name (FROM target). */
	readonly stable: string;
	/** Revive declared columns (bigint/timestamp → `bigint`); skip everything else. */
	readonly hydrate: (row: Record<string, unknown>) => Record<string, unknown>;
	/** Declared column + tag property names (used to separate raw window extras). */
	readonly known: ReadonlySet<string>;
}

/**
 * Build the read-side schema from the 58.3 decorator getters. The `@Column`/
 * `@Tag` metadata is the ONLY source of truth — never `key in instance` (the
 * `@Column() declare x` pitfall, memory `project_atlas_declare_hydration`).
 */
function buildQuerySchema(entityClass: SuperTableClass): QuerySchema {
	const meta = getSuperTableMetadata(entityClass);
	if (!meta) {
		throw new Error(
			`[E_EON_NOT_A_SUPERTABLE] ${entityClass.name} is not decorated with @SuperTable`,
		);
	}
	const tsProperty = getTimestampColumn(entityClass);
	if (!tsProperty) {
		throw new Error(
			`[E_EON_NO_TIMESTAMP] super-table '${meta.name}' has no @Timestamp column`,
		);
	}

	const columns = getColumnMetadata(entityClass);
	const tags = getTagMetadata(entityClass);
	const known = new Set<string>([
		...columns.map((c) => c.propertyKey),
		...tags.map((t) => t.propertyKey),
	]);
	// A column reads back as `bigint` when it is the timestamp primary column or
	// its logical type is a 64-bit integer — parity with the compile-boundary
	// precision guard, so a nanosecond `ts` or a BIGINT metric never narrows to a
	// lossy double.
	const bigintColumns = new Set<string>();
	for (const column of columns) {
		if (column.propertyKey === tsProperty || isBigintLogicalType(column.type)) {
			bigintColumns.add(column.propertyKey);
		}
	}
	for (const tag of tags) {
		if (isBigintLogicalType(tag.type)) bigintColumns.add(tag.propertyKey);
	}

	const hydrate = (row: Record<string, unknown>): Record<string, unknown> => {
		// Decode by metadata membership, iterating the raw row's own keys — never
		// `for (key in instance)` (a `declare` field is not an own property).
		const point: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) {
			if (!known.has(key)) continue;
			// `defineProperty`, not assignment: a column named `__proto__`/`constructor`
			// would otherwise hit the inherited accessor and re-parent `point`.
			Object.defineProperty(point, key, {
				value: bigintColumns.has(key) ? reviveBigInt(value) : value,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return point;
	};

	return { stable: meta.name, hydrate, known };
}

/**
 * Logical types that read back as 64-bit integers. Matched case-insensitively
 * and including the `bigInteger` alias, so it stays in lock-step with the DDL /
 * bind side (`TYPE_KIND_MAP` accepts `bigint`/`bigInteger`/any-case `BIGINT`) —
 * a divergence here would read a genuine BIGINT column back as a lossy `number`.
 */
function isBigintLogicalType(type: string | undefined): boolean {
	if (type === undefined) return false;
	const t = type.toLowerCase();
	return t === "bigint" || t === "biginteger" || t === "timestamp";
}

/**
 * Revive a raw column value into a `bigint` for a timestamp / BIGINT column.
 * Accepts an existing `bigint`, an integer `number`, or an all-digits string;
 * passes `null`/`undefined` through (a nullable window aggregate). Anything else
 * — a fractional number, an unexpected type — fails loud rather than silently
 * narrowing precision.
 */
function reviveBigInt(value: unknown): unknown {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new Error(
				`[E_EON_HYDRATE_BIGINT] expected an integer for a bigint/timestamp column, got the non-integer ${value}`,
			);
		}
		if (!Number.isSafeInteger(value)) {
			throw new Error(
				`[E_EON_HYDRATE_BIGINT] integer ${value} exceeds the JS safe-integer range (2^53) and has already lost precision; the transport must hand a bigint/timestamp column back as bigint or a string, not a lossy number`,
			);
		}
		return BigInt(value);
	}
	if (typeof value === "string" && /^-?\d+$/.test(value)) {
		return BigInt(value);
	}
	if (value === null || value === undefined) return value;
	throw new Error(
		`[E_EON_HYDRATE_BIGINT] cannot revive a bigint/timestamp column from a ${typeof value}`,
	);
}
