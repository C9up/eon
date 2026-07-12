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
}

export interface DropStableSpec {
	kind: "dropStable";
	name: string;
	ifExists: boolean;
}
