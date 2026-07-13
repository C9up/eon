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
import { childTableName, stringifyTagValue } from "../schema/sync.js";

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

/**
 * Element-wise equality of two normalised tag-value tuples. Compares on the SAME
 * canonical form {@link childTableName} hashes with ({@link stringifyTagValue}),
 * not by reference — otherwise two structurally-equal but distinct object/JSON
 * `@Tag` references (which hash to the same child) would read as unequal and
 * trip a spurious `E_EON_CHILD_COLLISION`, blocking a legitimate batch. A TRUE
 * hash collision of genuinely distinct tag-sets still differs here and is caught.
 */
function sameTagValues(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (stringifyTagValue(a[i]) !== stringifyTagValue(b[i])) return false;
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

/** Inclusive [min, max] value bounds per signed-integer bind kind. */
export const INT_BOUNDS: Readonly<
	Record<"tinyInt" | "smallInt" | "int" | "bigInt", readonly [bigint, bigint]>
> = {
	tinyInt: [-128n, 127n],
	smallInt: [-32768n, 32767n],
	int: [-2147483648n, 2147483647n],
	bigInt: [-9223372036854775808n, 9223372036854775807n],
};

/** Largest finite magnitude representable in IEEE-754 binary32 (`FLOAT`). */
export const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * Validate a non-timestamp value against its declared bind kind, rejecting the
 * silent-corruption inputs the connector setters would otherwise truncate or
 * coerce: a fractional/NaN/Infinity/string into an integer column, an integer
 * OUTSIDE the column's width (i8/i16/i32/i64) that would wrap, a non-finite or
 * f32-overflowing float, a non-boolean into a BOOL, or an object/array into a
 * scalar string/binary column. `null`/`undefined` are allowed and bound as NULL;
 * timestamps are validated separately by {@link coerceTimestamp}; JSON columns
 * legitimately carry objects and are left to the connector setter.
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
		case "bigInt": {
			let asBig: bigint;
			if (typeof value === "bigint") {
				asBig = value;
			} else if (
				typeof value === "number" &&
				Number.isInteger(value) &&
				Number.isSafeInteger(value)
			) {
				asBig = BigInt(value);
			} else {
				throw new Error(
					`[E_EON_VALUE_TYPE] integer column '${property}' requires a safe-integer number or bigint (got ${typeof value} ${String(value)}).`,
				);
			}
			const [min, max] = INT_BOUNDS[kind];
			if (asBig < min || asBig > max) {
				throw new Error(
					`[E_EON_VALUE_RANGE] ${kind} column '${property}' value ${String(value)} is outside the ${kind} range [${min}, ${max}]; the connector setter would truncate it silently.`,
				);
			}
			return;
		}
		case "float":
		case "double": {
			const asNum =
				typeof value === "bigint"
					? Number(value)
					: typeof value === "number"
						? value
						: undefined;
			if (asNum === undefined || !Number.isFinite(asNum)) {
				throw new Error(
					`[E_EON_VALUE_TYPE] float column '${property}' requires a finite number (got ${typeof value} ${String(value)}).`,
				);
			}
			if (kind === "float" && Math.abs(asNum) > FLOAT32_MAX) {
				throw new Error(
					`[E_EON_VALUE_RANGE] float (f32) column '${property}' value ${String(value)} exceeds the binary32 range and would be stored as Infinity; use a DOUBLE column.`,
				);
			}
			return;
		}
		case "bool":
			if (typeof value === "boolean") return;
			throw new Error(
				`[E_EON_VALUE_TYPE] bool column '${property}' requires a boolean (got ${typeof value} ${String(value)}).`,
			);
		case "varchar":
		case "nchar":
		case "varbinary":
			// Mirror the schemaless path's object-reject: a non-scalar bound to a
			// string/binary column stringifies to "[object Object]" — silent
			// corruption. JSON columns (below, via default) legitimately take objects.
			if (typeof value === "object") {
				throw new Error(
					`[E_EON_VALUE_TYPE] string/binary column '${property}' requires a scalar value, not an object/array.`,
				);
			}
			return;
		case "decimal":
			// DECIMAL binds as a string/number to preserve precision; only a
			// non-finite number (NaN/Infinity) is unrenderable — reject it.
			if (typeof value === "number" && !Number.isFinite(value)) {
				throw new Error(
					`[E_EON_VALUE_TYPE] decimal column '${property}' requires a finite number or a string (got ${String(value)}).`,
				);
			}
			return;
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
