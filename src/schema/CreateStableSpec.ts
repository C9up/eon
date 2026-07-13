/**
 * TypeScript spec shapes mirroring the Rust `crates/eon-query/src/ddl.rs`
 * structs, plus the logical → compiler-kind type map (parallel to atlas
 * `schema/types.ts`).
 *
 * The facade assembles these plain JSON objects from decorator metadata and
 * hands them to `compileStatementNative`; the Rust compiler owns all quoting,
 * type-mapping, and schema-rule validation — the TS side never string-builds
 * SQL (D1, the injection seam stays in Rust).
 */

/** The user-facing logical type strings accepted on `@Column`/`@Tag`/`@Timestamp`. */
export type EonLogicalType =
	| "timestamp"
	| "int"
	| "integer"
	| "bigint"
	| "biginteger"
	| "smallint"
	| "tinyint"
	| "float"
	| "double"
	| "bool"
	| "boolean"
	| "string"
	| "varchar"
	| "nchar"
	| "binary"
	| "varbinary"
	| "json"
	| "decimal";

/**
 * Map a logical type string to the compiler's `ColumnTypeKind` (serde
 * camelCase). Common aliases collapse onto one kind (`int`/`integer` → `int`,
 * `string`/`varchar` → `varchar`, `binary`/`varbinary` → `varbinary`). Physical
 * TDengine types are resolved from these kinds in Rust (`Dialect::map_column_type`).
 */
const TYPE_KIND_ENTRIES = {
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
	// `satisfies` makes this exhaustive + exact against EonLogicalType (a missing
	// or stray key is a compile error) while the exported map stays string-keyed
	// so an arbitrary logical string can be looked up without a cast.
} satisfies Record<EonLogicalType, string>;

export const TYPE_KIND_MAP: Record<string, string> = TYPE_KIND_ENTRIES;

/** A column or tag definition — the flattened `StableColumnDef` + `ColumnTypeSpec`. */
export interface EonColumnSpec {
	name: string;
	kind: string;
	length: number | null;
	precision: number | null;
	scale: number | null;
}

export interface CreateStableSpec {
	kind: "createStable";
	name: string;
	columns: EonColumnSpec[];
	tags: EonColumnSpec[];
	ifNotExists: boolean;
	/** Optional STABLE `KEEP` retention (a 3.3.x+ TDengine feature). Validated as a duration in Rust. */
	keep?: string;
}

/** One `ALTER STABLE` change — tagged on `op`, mirroring the Rust `AlterChange`. */
export type AlterChange =
	| { op: "addColumn"; name: string; type: Omit<EonColumnSpec, "name"> }
	| { op: "dropColumn"; name: string }
	| { op: "modifyColumn"; name: string; type: Omit<EonColumnSpec, "name"> }
	| { op: "addTag"; name: string; type: Omit<EonColumnSpec, "name"> }
	| { op: "dropTag"; name: string }
	| { op: "modifyTag"; name: string; type: Omit<EonColumnSpec, "name"> }
	| { op: "renameTag"; from: string; to: string };

export interface AlterStableSpec {
	kind: "alterStable";
	name: string;
	changes: AlterChange[];
}

export interface CreateChildTableSpec {
	kind: "createChildTable";
	name: string;
	using: string;
	tags: unknown[];
	ifNotExists: boolean;
	/** Inline tag values as SQL literals (58.3 `exec`) vs `?` placeholders (STMT, 58.4). */
	literal: boolean;
	/** Optional child-table `TTL` in whole days (`>= 0`, a 3.3.x+ TDengine feature). */
	ttl?: number;
}

export interface DropStableSpec {
	kind: "dropStable";
	name: string;
	ifExists: boolean;
}

/** TDengine timestamp precision — the create-only `PRECISION` database option. */
export type EonPrecision = "ms" | "us" | "ns";

/** TDengine `CACHEMODEL` allowlist. */
export type EonCacheModel = "none" | "last_row" | "last_value" | "both";

/**
 * `CREATE DATABASE` options (retention / storage). Every value is validated in
 * Rust (durations, precision/cachemodel/wal-level allowlists, `KEEP >= 3x
 * DURATION`). Options are emitted only when present, in a fixed order.
 */
export interface EonDatabaseOptions {
	/** Retention duration (e.g. `"90d"`). Must be `>= 3 x DURATION` when both are set with the same unit. */
	keep?: string;
	/** Per-file time span (e.g. `"10d"`). Create-only — cannot be altered. */
	duration?: string;
	/** Timestamp precision. Create-only — cannot be altered. */
	precision?: EonPrecision;
	/** Write buffer size in MB. */
	buffer?: number;
	/** WAL level (1 or 2). */
	walLevel?: 1 | 2;
	/** Row cache mode. */
	cachemodel?: EonCacheModel;
}

export interface CreateDatabaseSpec extends EonDatabaseOptions {
	kind: "createDatabase";
	name: string;
	ifNotExists: boolean;
}

/**
 * `ALTER DATABASE` — TDengine changes exactly ONE option per statement, so
 * exactly one field must be set. Create-only options (`PRECISION`/`DURATION`)
 * are intentionally absent here.
 */
export interface EonAlterDatabaseOptions {
	keep?: string;
	buffer?: number;
	walLevel?: 1 | 2;
	cachemodel?: EonCacheModel;
	replica?: number;
	minrows?: number;
}

export interface AlterDatabaseSpec {
	kind: "alterDatabase";
	name: string;
	/** The Rust-side option name (e.g. `"keep"`, `"wal_level"`). */
	option: string;
	value: string | number;
}

/** A basic (non-super) table: first column `TIMESTAMP`, then columns, no `TAGS`. */
export interface CreateTableSpec {
	kind: "createTable";
	name: string;
	columns: EonColumnSpec[];
	ifNotExists: boolean;
}

export interface DropTableSpec {
	kind: "dropTable";
	name: string;
	ifExists: boolean;
}
