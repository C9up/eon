/**
 * STMT columnar bulk-ingest planning (story 58.4) — the default high-throughput
 * write path.
 *
 * This module turns plain point objects into the transport-agnostic
 * {@link EonColumnarIngest} request: it groups points by their (deterministic)
 * child table, accumulates **struct-of-arrays columns** per child (one typed
 * array per column, NOT an array of row objects — the locked 58.0 contract, kept
 * even on the ws path), chunks each child at `batchSize`, and carries the
 * compiler-produced STMT template. The actual `stmtInit`/`bind`/`exec` happens
 * in the transport (`EonConnection.ingestColumnar`); this module never touches a
 * ws-specific type. The SQL template is produced ONLY by the Rust compiler — the
 * injection seam stays in Rust (memory `feedback_security_first`).
 */

import type {
	EonBindKind,
	EonBoundColumn,
	EonChildBatch,
	EonColumnarIngest,
} from "../connection/EonConnection.js";
import { compileStatementNative } from "../query/native.js";
import { childTableName } from "../schema/sync.js";

/** The default STMT batch chunk (rows per child per bind). Overridable (OQ3). */
export const DEFAULT_BATCH_SIZE = 4096;

/**
 * Logical column/tag type → the columnar bind kind that selects the transport
 * setter. Typed precisely as `EonBindKind` (unlike the string-valued
 * `TYPE_KIND_MAP`) so the plan carries a validated kind with no cast. Same
 * logical alias set as the DDL type map.
 */
const BIND_KIND_BY_LOGICAL: Record<string, EonBindKind> = {
	timestamp: "timestamp",
	int: "int",
	integer: "int",
	bigint: "bigInt",
	biginteger: "bigInt",
	smallint: "smallInt",
	tinyint: "tinyInt",
	float: "float",
	double: "double",
	bool: "bool",
	boolean: "bool",
	string: "varchar",
	varchar: "varchar",
	nchar: "nchar",
	binary: "varbinary",
	varbinary: "varbinary",
	json: "json",
	decimal: "decimal",
};

/** Resolve a logical column/tag type to its bind kind, or throw a typed error. */
export function toBindKind(
	logicalType: string | undefined,
	property: string,
): EonBindKind {
	const kind = BIND_KIND_BY_LOGICAL[(logicalType ?? "").toLowerCase()];
	if (!kind) {
		throw new Error(
			`[E_EON_TYPE] column/tag '${property}' has an unknown or missing type '${logicalType ?? ""}'`,
		);
	}
	return kind;
}

/** A column (or tag) in the ingest plan: its entity property + bind kind. */
export interface PlanColumn {
	readonly property: string;
	readonly kind: EonBindKind;
}

/** Resolved plan for one super-table's STMT ingest (built once per repository). */
export interface ColumnarPlan {
	readonly stable: string;
	readonly templateSql: string;
	readonly tsProperty: string;
	/** Value columns, timestamp first (prepared bind order). */
	readonly columns: readonly PlanColumn[];
	readonly tags: readonly PlanColumn[];
	readonly batchSize: number;
}

/** A point: a plain object keyed by the entity's property names. */
export type IngestPoint = Record<string, unknown>;

/**
 * Compile the STMT prepare template for a super-table via the Rust compiler
 * (`INSERT INTO ? USING <stable> (<tagcols>) TAGS (?) VALUES (?)`). The single
 * SQL authority stays in Rust — this never string-builds SQL.
 */
export function compileStmtTemplate(
	stable: string,
	tagColumns: readonly string[],
	columns: readonly string[],
): string {
	const compiled = compileStatementNative(
		{
			kind: "stmtInsertTemplate",
			using: stable,
			tagColumns: [...tagColumns],
			columns: [...columns],
		},
		"tdengine",
	);
	const sql = compiled.statements[0];
	if (sql === undefined) {
		throw new Error(
			"[E_EON_TEMPLATE] the compiler returned no statement for the STMT insert template",
		);
	}
	return sql;
}

/** A child table's grouped rows + the tag values that route to it. */
export interface ChildGroup {
	readonly table: string;
	readonly tagValues: unknown[];
	readonly rows: IngestPoint[];
}

/**
 * Group points by their deterministic child table (same tags → same child).
 * Tag values are normalised (`undefined` → `null`) so routing is stable and a
 * missing tag can never desync the FNV child name.
 */
export function groupByChild(
	stable: string,
	tagProperties: readonly string[],
	points: readonly IngestPoint[],
): ChildGroup[] {
	const groups = new Map<string, ChildGroup>();
	for (const point of points) {
		const tagValues = tagProperties.map((p) => point[p] ?? null);
		const table = childTableName(stable, tagValues);
		let group = groups.get(table);
		if (!group) {
			group = { table, tagValues, rows: [] };
			groups.set(table, group);
		} else if (!sameTagValues(group.tagValues, tagValues)) {
			// Defence-in-depth behind the 64-bit child name: if two DISTINCT
			// tag-sets ever hashed to the same child, later points would bind under
			// the first set's tags (silent cross-series corruption). Refuse loudly
			// instead — astronomically unlikely at 64 bits, never silent.
			throw new Error(
				`[E_EON_CHILD_COLLISION] two distinct tag-sets map to the same child table '${table}'; refusing to write mismatched rows under one tag-set.`,
			);
		}
		group.rows.push(point);
	}
	return [...groups.values()];
}

/** Element-wise equality of two normalised tag-value tuples (null/primitive/bigint). */
function sameTagValues(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Coerce a timestamp value to `bigint`, honouring the 58.1
 * `E_EON_PARAM_PRECISION` boundary: a `number` that is not a safe integer has
 * already lost precision, so it is rejected loud rather than bound corrupted.
 */
export function coerceTimestamp(value: unknown, property: string): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") {
		if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
			throw new Error(
				`[E_EON_PARAM_PRECISION] timestamp '${property}' value ${value} is not a safe integer; pass nanosecond/BIGINT timestamps as bigint.`,
			);
		}
		return BigInt(value);
	}
	throw new Error(
		`[E_EON_TS_TYPE] timestamp '${property}' must be a bigint or a safe-integer number (got ${typeof value}).`,
	);
}

/**
 * Validate a non-timestamp value against its declared bind kind, rejecting the
 * silent-corruption inputs the connector setters would otherwise truncate or
 * coerce: a fractional/NaN/Infinity/string into an integer column, a non-finite
 * float, or a truthy non-boolean into a BOOL. `null`/`undefined` are allowed and
 * bound as NULL; timestamps are validated separately by {@link coerceTimestamp}.
 * String/binary/json/decimal payloads are left to the connector setter.
 */
export function assertColumnValue(
	value: unknown,
	kind: EonBindKind,
	property: string,
): void {
	if (value === null || value === undefined) return;
	switch (kind) {
		case "int":
		case "smallInt":
		case "tinyInt":
			if (typeof value === "bigint") return;
			if (
				typeof value === "number" &&
				Number.isInteger(value) &&
				Number.isSafeInteger(value)
			) {
				return;
			}
			throw new Error(
				`[E_EON_VALUE_TYPE] integer column '${property}' requires a safe-integer number or bigint (got ${typeof value} ${String(value)}).`,
			);
		case "bigInt":
			if (typeof value === "bigint") return;
			if (typeof value === "number" && Number.isSafeInteger(value)) return;
			throw new Error(
				`[E_EON_VALUE_TYPE] bigint column '${property}' requires a bigint or safe-integer number (got ${typeof value} ${String(value)}).`,
			);
		case "float":
		case "double":
			if (typeof value === "bigint") return;
			if (typeof value === "number" && Number.isFinite(value)) return;
			throw new Error(
				`[E_EON_VALUE_TYPE] float column '${property}' requires a finite number (got ${typeof value} ${String(value)}).`,
			);
		case "bool":
			if (typeof value === "boolean") return;
			throw new Error(
				`[E_EON_VALUE_TYPE] bool column '${property}' requires a boolean (got ${typeof value} ${String(value)}).`,
			);
		default:
			return;
	}
}

/**
 * Build the columnar STMT ingest request from a plan + points: group by child,
 * chunk at `batchSize`, and accumulate one SoA column per value column and one
 * single-element column per tag. NO per-row object is produced.
 */
export function buildColumnarIngest(
	plan: ColumnarPlan,
	points: readonly IngestPoint[],
): EonColumnarIngest {
	const children: EonChildBatch[] = [];
	const tagProps = plan.tags.map((t) => t.property);

	for (const group of groupByChild(plan.stable, tagProps, points)) {
		for (let start = 0; start < group.rows.length; start += plan.batchSize) {
			const slice = group.rows.slice(start, start + plan.batchSize);
			const columns: EonBoundColumn[] = plan.columns.map((col) => ({
				kind: col.kind,
				values:
					col.property === plan.tsProperty
						? slice.map((pt) => coerceTimestamp(pt[col.property], col.property))
						: slice.map((pt) => {
								const value = pt[col.property] ?? null;
								assertColumnValue(value, col.kind, col.property);
								return value;
							}),
			}));
			const tags: EonBoundColumn[] = plan.tags.map((tag, i) => {
				const value = group.tagValues[i] ?? null;
				assertColumnValue(value, tag.kind, tag.property);
				return { kind: tag.kind, values: [value] };
			});
			children.push({ table: group.table, tags, columns });
		}
	}

	return { sql: plan.templateSql, children };
}
