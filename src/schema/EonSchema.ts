/**
 * `EonSchema` — the fluent DDL surface a migration's `up()`/`down()` drives.
 *
 * Mirrors atlas `Schema` (`schema/Schema.ts`) in shape: each method compiles its
 * spec through the Rust `compileStatementNative` seam and appends the resulting
 * SQL to an internal buffer the runner flushes. The TS side NEVER string-builds
 * SQL — every identifier, literal, and option value is quoted/validated in Rust
 * (the injection seam stays in one place, memory `feedback_security_first`).
 *
 * The `StableBuilder` is intentionally THINNER than atlas `TableBuilder`:
 * TDengine columns have no `DEFAULT`, no per-column `PRIMARY KEY` choice (the
 * first `TIMESTAMP` is always the key), no `UNIQUE`, no foreign keys, no SQL
 * secondary indexes — so `defaultTo`/`primary`/`unique`/`references`/`increments`
 * have NO analogue and are deliberately absent (D — the reconciliation note).
 */

import { compileStatementNative } from "../query/native.js";
import type {
	AlterChange,
	AlterDatabaseSpec,
	AlterStableSpec,
	CreateStableSpec,
	CreateTableSpec,
	EonAlterDatabaseOptions,
	EonColumnSpec,
	EonDatabaseOptions,
} from "./CreateStableSpec.js";

/** Build one column/tag spec — the ONE place logical type args become an `EonColumnSpec`. */
function columnSpec(
	name: string,
	kind: string,
	length: number | null = null,
	precision: number | null = null,
	scale: number | null = null,
): EonColumnSpec {
	return { name, kind, length, precision, scale };
}

/** The type portion of an `EonColumnSpec` (everything but the name). */
type EonType = Omit<EonColumnSpec, "name">;

/** Build the type portion — the ONE place logical type args become an `EonType`. */
function makeType(
	kind: string,
	length: number | null = null,
	precision: number | null = null,
	scale: number | null = null,
): EonType {
	return { kind, length, precision, scale };
}

/**
 * The thin column/tag surface shared by every builder: only column-type methods
 * (+ length/precision/scale). No `defaultTo`/`primary`/`unique` — TDengine has
 * no analogue. Each method appends a column via `#add` and returns whatever that
 * hook returns (a tag-handle for stables, `void` for basic tables).
 */
abstract class ColumnMethods<R> {
	protected abstract add(spec: EonColumnSpec): R;

	timestamp(name: string): R {
		return this.add(columnSpec(name, "timestamp"));
	}
	int(name: string): R {
		return this.add(columnSpec(name, "int"));
	}
	bigInteger(name: string): R {
		return this.add(columnSpec(name, "bigInt"));
	}
	float(name: string): R {
		return this.add(columnSpec(name, "float"));
	}
	double(name: string): R {
		return this.add(columnSpec(name, "double"));
	}
	bool(name: string): R {
		return this.add(columnSpec(name, "bool"));
	}
	varchar(name: string, length: number): R {
		return this.add(columnSpec(name, "varchar", length));
	}
	nchar(name: string, length: number): R {
		return this.add(columnSpec(name, "nchar", length));
	}
	binary(name: string, length: number): R {
		return this.add(columnSpec(name, "varbinary", length));
	}
	decimal(name: string, precision: number, scale?: number): R {
		return this.add(
			columnSpec(name, "decimal", null, precision, scale ?? null),
		);
	}
	json(name: string): R {
		return this.add(columnSpec(name, "json"));
	}
}

/**
 * The no-name type surface for an `ALTER STABLE` add/modify change: the column
 * name is already fixed (by `addColumn(name)` etc.), so these methods take ONLY
 * the type arguments and finalize the change.
 */
abstract class TypeMethods<R> {
	protected abstract emit(type: EonType): R;

	timestamp(): R {
		return this.emit(makeType("timestamp"));
	}
	int(): R {
		return this.emit(makeType("int"));
	}
	bigInteger(): R {
		return this.emit(makeType("bigInt"));
	}
	float(): R {
		return this.emit(makeType("float"));
	}
	double(): R {
		return this.emit(makeType("double"));
	}
	bool(): R {
		return this.emit(makeType("bool"));
	}
	varchar(length: number): R {
		return this.emit(makeType("varchar", length));
	}
	nchar(length: number): R {
		return this.emit(makeType("nchar", length));
	}
	binary(length: number): R {
		return this.emit(makeType("varbinary", length));
	}
	decimal(precision: number, scale?: number): R {
		return this.emit(makeType("decimal", null, precision, scale ?? null));
	}
	json(): R {
		return this.emit(makeType("json"));
	}
}

/** A handle returned by a `StableBuilder` column method — `.tag()` re-homes it as a tag. */
export interface StableColumnHandle {
	/** Mark the just-declared column as a `TAG` instead of a metric column. */
	tag(): void;
}

/** Fluent builder for `CREATE STABLE` columns + tags (ts-first is enforced in Rust). */
export class StableBuilder extends ColumnMethods<StableColumnHandle> {
	readonly #columns: EonColumnSpec[] = [];
	readonly #tags: EonColumnSpec[] = [];

	protected add(spec: EonColumnSpec): StableColumnHandle {
		this.#columns.push(spec);
		return {
			tag: () => {
				// Idempotent: a second `.tag()` on the same handle finds the spec
				// already re-homed (i < 0) and must NOT push a duplicate tag.
				const i = this.#columns.indexOf(spec);
				if (i >= 0) {
					this.#columns.splice(i, 1);
					this.#tags.push(spec);
				}
			},
		};
	}

	/** @internal */
	columns(): EonColumnSpec[] {
		return this.#columns;
	}
	/** @internal */
	tags(): EonColumnSpec[] {
		return this.#tags;
	}
}

/** Fluent builder for a basic (non-super) table — same columns, no tags. */
export class BasicTableBuilder extends ColumnMethods<void> {
	readonly #columns: EonColumnSpec[] = [];

	protected add(spec: EonColumnSpec): void {
		this.#columns.push(spec);
	}

	/** @internal */
	columns(): EonColumnSpec[] {
		return this.#columns;
	}
}

/** Sets the type on a pending `ALTER STABLE` add/modify change, then records it. */
export interface AlterTypeSetter extends TypeMethods<void> {}
class AlterTypeSetterImpl extends TypeMethods<void> {
	readonly #record: (type: EonType) => void;
	constructor(record: (type: EonType) => void) {
		super();
		this.#record = record;
	}
	protected emit(type: EonType): void {
		this.#record(type);
	}
}

/** Fluent builder for `ALTER STABLE` — one method per TDengine change op. */
export class AlterStableBuilder {
	readonly #changes: AlterChange[] = [];

	addColumn(name: string): AlterTypeSetter {
		return new AlterTypeSetterImpl((type) =>
			this.#changes.push({ op: "addColumn", name, type }),
		);
	}
	modifyColumn(name: string): AlterTypeSetter {
		return new AlterTypeSetterImpl((type) =>
			this.#changes.push({ op: "modifyColumn", name, type }),
		);
	}
	dropColumn(name: string): this {
		this.#changes.push({ op: "dropColumn", name });
		return this;
	}
	addTag(name: string): AlterTypeSetter {
		return new AlterTypeSetterImpl((type) =>
			this.#changes.push({ op: "addTag", name, type }),
		);
	}
	modifyTag(name: string): AlterTypeSetter {
		return new AlterTypeSetterImpl((type) =>
			this.#changes.push({ op: "modifyTag", name, type }),
		);
	}
	dropTag(name: string): this {
		this.#changes.push({ op: "dropTag", name });
		return this;
	}
	renameTag(from: string, to: string): this {
		this.#changes.push({ op: "renameTag", from, to });
		return this;
	}

	/** @internal */
	changes(): AlterChange[] {
		return this.#changes;
	}
}

/** Map an `alterDatabase` option key to its Rust-side option name. */
const ALTER_DB_OPTION_NAMES: Record<keyof EonAlterDatabaseOptions, string> = {
	keep: "keep",
	buffer: "buffer",
	walLevel: "wal_level",
	cachemodel: "cachemodel",
	replica: "replica",
	minrows: "minrows",
};

export class EonSchema {
	#statements: string[] = [];

	#push(spec: object): void {
		const { statements } = compileStatementNative(spec, "tdengine");
		this.#statements.push(...statements);
	}

	/**
	 * `CREATE STABLE`. Defaults to `IF NOT EXISTS` (idempotent DDL — the mitigation
	 * for TDengine's non-transactional migrations, AC6). Pass `keep` for retention.
	 */
	createStable(
		name: string,
		callback: (table: StableBuilder) => void,
		options: { ifNotExists?: boolean; keep?: string } = {},
	): this {
		const builder = new StableBuilder();
		callback(builder);
		const spec: CreateStableSpec = {
			kind: "createStable",
			name,
			columns: builder.columns(),
			tags: builder.tags(),
			ifNotExists: options.ifNotExists ?? true,
			...(options.keep !== undefined ? { keep: options.keep } : {}),
		};
		this.#push(spec);
		return this;
	}

	/** `ALTER STABLE` → one statement per change. */
	alterStable(
		name: string,
		callback: (table: AlterStableBuilder) => void,
	): this {
		const builder = new AlterStableBuilder();
		callback(builder);
		const spec: AlterStableSpec = {
			kind: "alterStable",
			name,
			changes: builder.changes(),
		};
		this.#push(spec);
		return this;
	}

	/** `DROP STABLE IF EXISTS`. */
	dropStable(name: string): this {
		this.#push({ kind: "dropStable", name, ifExists: true });
		return this;
	}

	/** `CREATE DATABASE IF NOT EXISTS` with optional retention/storage options. */
	createDatabase(name: string, options: EonDatabaseOptions = {}): this {
		this.#push({
			kind: "createDatabase",
			name,
			ifNotExists: true,
			...options,
		});
		return this;
	}

	/**
	 * `ALTER DATABASE` — exactly ONE option per call (TDengine restriction).
	 * Throws if zero or more than one option key is provided.
	 */
	alterDatabase(name: string, options: EonAlterDatabaseOptions): this {
		const keys: (keyof EonAlterDatabaseOptions)[] = [
			"keep",
			"buffer",
			"walLevel",
			"cachemodel",
			"replica",
			"minrows",
		];
		const set = keys.filter((k) => options[k] !== undefined);
		const key = set[0];
		if (set.length !== 1 || key === undefined) {
			throw new Error(
				`[E_EON_ALTER_DB_ONE_OPTION] alterDatabase('${name}', …) requires exactly one option, got ${set.length}`,
			);
		}
		const value = options[key];
		if (value === undefined) {
			throw new Error(
				`[E_EON_ALTER_DB_ONE_OPTION] alterDatabase('${name}', …) option '${key}' has no value`,
			);
		}
		const spec: AlterDatabaseSpec = {
			kind: "alterDatabase",
			name,
			option: ALTER_DB_OPTION_NAMES[key],
			value,
		};
		this.#push(spec);
		return this;
	}

	/** `CREATE TABLE IF NOT EXISTS` — a basic (non-super) table, no tags. */
	createTable(
		name: string,
		callback: (table: BasicTableBuilder) => void,
	): this {
		const builder = new BasicTableBuilder();
		callback(builder);
		const spec: CreateTableSpec = {
			kind: "createTable",
			name,
			columns: builder.columns(),
			ifNotExists: true,
		};
		this.#push(spec);
		return this;
	}

	/** `DROP TABLE IF EXISTS`. */
	dropTable(name: string): this {
		this.#push({ kind: "dropTable", name, ifExists: true });
		return this;
	}

	/** Queue a raw SQL statement verbatim (an escape hatch for options not modelled above). */
	raw(sql: string): this {
		this.#statements.push(sql);
		return this;
	}

	/** Clear the buffer (called before each `up()`/`down()` run). */
	reset(): void {
		this.#statements = [];
	}

	/** The compiled SQL statements queued so far. */
	toSQL(): string[] {
		return [...this.#statements];
	}
}
