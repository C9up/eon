/**
 * Super-table decorators — the Atlas-shaped declarative schema layer for
 * TDengine, adapted to the STable / tag / child-table model.
 *
 * `@SuperTable` marks a class (mirror atlas `@Entity`); `@Timestamp` is the
 * mandatory first `TIMESTAMP` primary column (the eon analogue of atlas
 * `@PrimaryKey`, which likewise registers a column); `@Column` is a metric
 * column; `@Tag` registers into a SEPARATE tag registry (TDengine's tags have
 * no atlas analogue — this is the one intrinsic divergence, D2).
 *
 * Because eon entities use `@Column() declare x` (memory
 * `project_atlas_declare_hydration`), `x in instance` is ALWAYS false at
 * runtime — every consumer reads schema through the getters below, NEVER from
 * instance keys.
 */

import "reflect-metadata";
import {
	COLUMNS_KEY,
	SUPER_TABLE_KEY,
	TAGS_KEY,
	TIMESTAMP_KEY,
} from "../metadata-keys.js";

/** Options for `@Timestamp` / `@Column`. `type` is a LOGICAL type string. */
export interface EonColumnOptions {
	/** Logical type (e.g. `"float"`, `"int"`, `"varchar"`). Mapped to a TDengine physical type in the compiler. */
	type?: string;
	/** Length for `varchar` / `nchar` / `varbinary` — required for those types. */
	length?: number;
	/** Precision for `decimal` — required for `decimal`. */
	precision?: number;
	/** Scale for `decimal`. */
	scale?: number;
	/** Whether the column is nullable (metadata only — TDengine columns are nullable by default). */
	nullable?: boolean;
}

/** Options for `@Tag` — same as a column minus `nullable` (tags are always nullable-on-partial-insert). */
export type EonTagOptions = Omit<EonColumnOptions, "nullable">;

/** Metric-column metadata (declaration order preserved). */
export interface EonColumnMetadata {
	propertyKey: string;
	type?: string;
	length?: number;
	precision?: number;
	scale?: number;
	nullable?: boolean;
}

/** Tag metadata (declaration order preserved). */
export interface EonTagMetadata {
	propertyKey: string;
	type?: string;
	length?: number;
	precision?: number;
	scale?: number;
}

/** Super-table descriptor. */
export interface SuperTableMetadata {
	name: string;
}

/** `@SuperTable('name')` — marks a class as a TDengine super-table. */
export function SuperTable(name: string): ClassDecorator {
	return (target) => {
		Reflect.defineMetadata(SUPER_TABLE_KEY, { name }, target);
	};
}

/** Push a metric column onto the registry, deduping on re-decoration (mirror atlas `@Column`). */
function pushColumn(
	ctor: object,
	propertyKey: string,
	options: EonColumnOptions | undefined,
): void {
	const columns: EonColumnMetadata[] =
		Reflect.getOwnMetadata(COLUMNS_KEY, ctor) ?? [];
	if (!columns.some((c) => c.propertyKey === propertyKey)) {
		columns.push({
			propertyKey,
			type: options?.type,
			length: options?.length,
			precision: options?.precision,
			scale: options?.scale,
			nullable: options?.nullable,
		});
		Reflect.defineMetadata(COLUMNS_KEY, columns, ctor);
	}
}

/**
 * `@Timestamp()` — the mandatory first `TIMESTAMP` primary column. Exactly one
 * per super-table (enforced by the compiler, AC5). Registers a
 * `type: "timestamp"` metric column AND records the ts property name.
 */
export function Timestamp(options?: EonColumnOptions): PropertyDecorator {
	return (target, propertyKey) => {
		const key = String(propertyKey);
		Reflect.defineMetadata(TIMESTAMP_KEY, key, target.constructor);
		pushColumn(target.constructor, key, {
			...options,
			type: options?.type ?? "timestamp",
		});
	};
}

/** `@Column()` — a metric column. */
export function Column(options?: EonColumnOptions): PropertyDecorator {
	return (target, propertyKey) => {
		pushColumn(target.constructor, String(propertyKey), options);
	};
}

/** `@Tag()` — a tag column, stored in a SEPARATE registry from metrics (D2). */
export function Tag(options?: EonTagOptions): PropertyDecorator {
	return (target, propertyKey) => {
		const ctor = target.constructor;
		const tags: EonTagMetadata[] = Reflect.getOwnMetadata(TAGS_KEY, ctor) ?? [];
		const key = String(propertyKey);
		if (!tags.some((t) => t.propertyKey === key)) {
			tags.push({
				propertyKey: key,
				type: options?.type,
				length: options?.length,
				precision: options?.precision,
				scale: options?.scale,
			});
			Reflect.defineMetadata(TAGS_KEY, tags, ctor);
		}
	};
}

/** Read the super-table descriptor for a class (`undefined` if undecorated). */
export function getSuperTableMetadata(
	target: object,
): SuperTableMetadata | undefined {
	const meta: SuperTableMetadata | undefined = Reflect.getMetadata(
		SUPER_TABLE_KEY,
		target,
	);
	return meta;
}

/** Read the timestamp column's property name (`undefined` if none). */
export function getTimestampColumn(target: object): string | undefined {
	const key: string | undefined = Reflect.getMetadata(TIMESTAMP_KEY, target);
	return key;
}

/** Read the metric-column metadata (declaration order), returning a copy. */
export function getColumnMetadata(target: object): EonColumnMetadata[] {
	const columns: EonColumnMetadata[] | undefined = Reflect.getMetadata(
		COLUMNS_KEY,
		target,
	);
	return [...(columns ?? [])];
}

/** Read the tag metadata (declaration order), returning a copy. */
export function getTagMetadata(target: object): EonTagMetadata[] {
	const tags: EonTagMetadata[] | undefined = Reflect.getMetadata(
		TAGS_KEY,
		target,
	);
	return [...(tags ?? [])];
}
