/**
 * Assemble a `CreateStableSpec` from a decorated super-table class.
 *
 * Reads schema through the metadata getters ONLY (never `key in instance` — the
 * `declare` pitfall, memory `project_atlas_declare_hydration`), places the
 * timestamp column first (TDengine's PK rule), and normalises each logical type
 * string to the compiler kind via `TYPE_KIND_MAP`. Mirror of atlas
 * `TableBuilder.toStatements` spec-build.
 */

import {
	type EonColumnMetadata,
	type EonTagMetadata,
	getColumnMetadata,
	getSuperTableMetadata,
	getTagMetadata,
	getTimestampColumn,
} from "../decorators/superTable.js";
import {
	type CreateStableSpec,
	type EonColumnSpec,
	TYPE_KIND_MAP,
} from "./CreateStableSpec.js";

/** A decorated super-table class. Every constructor carries `.name` (`Function.name`). */
export type SuperTableClass = (abstract new (
	...args: never[]
) => object) & {
	readonly name: string;
};

/** Resolve the super-table name for a class, or throw if it is undecorated. */
export function requireSuperTableName(EntityClass: SuperTableClass): string {
	const meta = getSuperTableMetadata(EntityClass);
	if (!meta) {
		const label =
			EntityClass.name.length > 0 ? EntityClass.name : "the given class";
		throw new Error(
			`[E_EON_NOT_A_SUPERTABLE] ${label} is not decorated with @SuperTable`,
		);
	}
	return meta.name;
}

/**
 * The stable's physical column order: timestamp first (TDengine's PK rule), then
 * declaration order. The STMT columnar bind is POSITIONAL (the connector's
 * prepare template omits the value-column list), so its bind order MUST match the
 * order the STABLE was created with. Both `compileCreateStableSpec` (the DDL) and
 * `SuperTableRepository`'s ingest plan derive their order from THIS one function
 * so the two can never silently drift apart and write values into wrong columns.
 */
export function orderTimestampFirst<T extends { propertyKey: string }>(
	columns: readonly T[],
	tsColumn: T,
	tsProperty: string,
): T[] {
	return [tsColumn, ...columns.filter((c) => c.propertyKey !== tsProperty)];
}

function toColumnSpec(meta: EonColumnMetadata | EonTagMetadata): EonColumnSpec {
	const logical = (meta.type ?? "").toLowerCase();
	const kind = TYPE_KIND_MAP[logical];
	if (!kind) {
		throw new Error(
			`[E_EON_TYPE] column/tag '${meta.propertyKey}' has an unknown or missing type '${meta.type ?? ""}'`,
		);
	}
	return {
		name: meta.propertyKey,
		kind,
		length: meta.length ?? null,
		precision: meta.precision ?? null,
		scale: meta.scale ?? null,
	};
}

/**
 * Build the `createStable` spec (ts column first). `ifNotExists` defaults to
 * `false`; `syncSuperTable` overrides it to `true`.
 */
export function compileCreateStableSpec(
	EntityClass: SuperTableClass,
): CreateStableSpec {
	const name = requireSuperTableName(EntityClass);
	const tsProperty = getTimestampColumn(EntityClass);
	if (!tsProperty) {
		throw new Error(
			`[E_EON_NO_TIMESTAMP] super-table '${name}' has no @Timestamp column`,
		);
	}

	const columns = getColumnMetadata(EntityClass);
	const tsColumn = columns.find((c) => c.propertyKey === tsProperty);
	if (!tsColumn) {
		throw new Error(
			`[E_EON_NO_TIMESTAMP] super-table '${name}' @Timestamp column '${tsProperty}' is not registered`,
		);
	}
	const orderedColumns = orderTimestampFirst(columns, tsColumn, tsProperty);

	return {
		kind: "createStable",
		name,
		columns: orderedColumns.map(toColumnSpec),
		tags: getTagMetadata(EntityClass).map(toColumnSpec),
		ifNotExists: false,
	};
}
