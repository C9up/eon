/**
 * `TimeSeriesQuery` — a fluent, Atlas-shaped time-series read builder for
 * TDengine (story 58.5). It mirrors the `@c9up/atlas` `ModelQuery` SUBSET that
 * makes sense for a super-table: filtering, projection (bare columns, aggregate
 * / selector functions, window pseudo-columns), the TDengine window clauses
 * (`INTERVAL` / `SLIDING` / `FILL` / `PARTITION BY`), ordering, paging, and the
 * `.then` thenable ergonomic. It deliberately OMITS the Atlas surface TDengine
 * has no analogue for (joins, CTEs, unions, preload, pivots, cursor-pagination).
 *
 * READ CRUX: `EonConnection.query(sql)` is literal-SQL-only — the ws transport
 * binds `?` exclusively through the STMT/write path. So every spec this builder
 * assembles carries `literal: true`, and the Rust compiler renders WHERE / IN /
 * FILL(VALUE …) constants as inline SQL literals through the audited
 * `render_literal` seam (never TS interpolation, memory `feedback_security_first`).
 * `params` therefore comes back empty; a non-empty `params` is a literal-mode
 * regression and is rejected before the SQL ever reaches the connection.
 *
 * The `.then` thenable makes `await query` ≡ `await query.exec()` (Lucid /
 * atlas `ModelQuery` parity). A `then` member trips Biome's recommended
 * `noThenProperty`, so — exactly as atlas does for the same reason — it carries
 * a single targeted `biome-ignore`: the thenable IS the public API here, there
 * is no trigger to refactor away.
 */

import type { EonConnection } from "../connection/EonConnection.js";
import { compileStatementNative } from "./native.js";

/** A scalar bindable into a WHERE predicate or a FILL(VALUE …) constant. */
export type EonScalar = string | number | bigint | boolean | null;

/** A WHERE value — a scalar, or a list for `IN` / `NOT IN`. */
export type EonWhereValue = EonScalar | readonly EonScalar[];

/** WHERE operators (mirrors the Rust `validate_operator` allowlist). */
export type EonWhereOperator =
	| "="
	| "!="
	| "<>"
	| ">"
	| ">="
	| "<"
	| "<="
	| "LIKE"
	| "NOT LIKE"
	| "IN"
	| "NOT IN"
	| "IS NULL"
	| "IS NOT NULL";

/** FILL modes in scope (58.5). `VALUE` carries the fill constants. */
export type EonFillMode =
	| "none"
	| "null"
	| "prev"
	| "next"
	| "linear"
	| "value";

/** ORDER BY direction. */
export type EonOrderDirection = "asc" | "desc";

/** An aggregate / selector function select item, e.g. `{ fn: "avg", column: "voltage" }`. */
export interface EonFunctionSelect {
	/** Function name (allowlisted in Rust: avg/sum/min/max/count/first/last/last_row/spread/twa). */
	readonly fn: string;
	/** Column argument (or `"*"` for `count`). */
	readonly column: string;
	/** Optional `AS` alias. */
	readonly as?: string;
}

/** A window pseudo-column select item, e.g. `{ pseudo: "_wstart" }`. */
export interface EonPseudoSelect {
	/** Pseudo-column: `_wstart` / `_wend` / `_wduration` / `tbname`. */
	readonly pseudo: string;
	/** Optional `AS` alias. */
	readonly as?: string;
}

/** A SELECT-list item: a bare column / pseudo-column name, or a structured expression. */
export type EonSelectItem = string | EonFunctionSelect | EonPseudoSelect;

// ─── Structural specs sent across the native boundary (serde camelCase) ───

type SelectItemSpec =
	| string
	| { function: string; column: string; alias?: string }
	| { pseudo: string; alias?: string };

type IntervalSpec = string | { value: string; offset?: string };

interface FillSpec {
	mode: string;
	values?: readonly EonScalar[];
}

interface WhereSpec {
	column: string;
	operator: string;
	value: EonWhereValue;
	type: "and" | "or";
}

interface OrderBySpec {
	column: string;
	direction: EonOrderDirection;
}

interface SelectSpec {
	kind: "select";
	table: string;
	select: SelectItemSpec[];
	wheres: WhereSpec[];
	partitionBy: string[];
	interval?: IntervalSpec;
	sliding?: string;
	fill?: FillSpec;
	orderBy: OrderBySpec[];
	limit?: number;
	offset?: number;
	literal: true;
}

/**
 * The `where`/`andWhere`/`orWhere` argument tuples. A rest tuple (not an optional
 * `value?`) so arity is exact: `where(col, op, undefined)` is a 3-element call and
 * is rejected, never silently reinterpreted as the 2-arg `col = <operator>` form.
 */
type WhereArgs =
	| readonly [column: string, value: EonWhereValue]
	| readonly [column: string, operator: EonWhereOperator, value: EonWhereValue];

/**
 * A fluent TDengine time-series query. Constructed by
 * {@link SuperTableRepository.query}; also usable standalone with a connection,
 * a hydrate closure, and the set of declared column names.
 *
 * @typeParam TPoint - the mapped row shape. Defaults to a column-keyed record;
 *   the repository binds it to the entity's columns via its hydrate closure.
 */
export class TimeSeriesQuery<TPoint extends object = Record<string, unknown>>
	implements PromiseLike<TPoint[]>
{
	readonly #table: string;
	readonly #conn: EonConnection;
	readonly #hydrate: (row: Record<string, unknown>) => TPoint;
	readonly #knownColumns: ReadonlySet<string>;

	readonly #select: EonSelectItem[] = [];
	readonly #wheres: WhereSpec[] = [];
	readonly #partitionBy: string[] = [];
	readonly #orderBy: OrderBySpec[] = [];
	#interval?: IntervalSpec;
	#sliding?: string;
	#fill?: FillSpec;
	#limit?: number;
	#offset?: number;
	#cachedExec?: Promise<TPoint[]>;

	constructor(
		table: string,
		conn: EonConnection,
		hydrate: (row: Record<string, unknown>) => TPoint,
		knownColumns: ReadonlySet<string>,
	) {
		this.#table = table;
		this.#conn = conn;
		this.#hydrate = hydrate;
		this.#knownColumns = knownColumns;
	}

	// ─── Filtering ───

	/** Add a WHERE predicate (AND-joined). Two-arg form is `(col, value)` with `=`. */
	where(column: string, value: EonWhereValue): this;
	where(column: string, operator: EonWhereOperator, value: EonWhereValue): this;
	where(...args: WhereArgs): this {
		return this.#pushWhere("and", args);
	}

	/** Alias of {@link where} — an explicit AND predicate. */
	andWhere(column: string, value: EonWhereValue): this;
	andWhere(
		column: string,
		operator: EonWhereOperator,
		value: EonWhereValue,
	): this;
	andWhere(...args: WhereArgs): this {
		return this.#pushWhere("and", args);
	}

	/** Add an OR-joined WHERE predicate. */
	orWhere(column: string, value: EonWhereValue): this;
	orWhere(
		column: string,
		operator: EonWhereOperator,
		value: EonWhereValue,
	): this;
	orWhere(...args: WhereArgs): this {
		return this.#pushWhere("or", args);
	}

	/** `col IS NULL`. */
	whereNull(column: string): this {
		this.#cachedExec = undefined;
		this.#wheres.push({
			column,
			operator: "IS NULL",
			value: null,
			type: "and",
		});
		return this;
	}

	/** `col IS NOT NULL`. */
	whereNotNull(column: string): this {
		this.#cachedExec = undefined;
		this.#wheres.push({
			column,
			operator: "IS NOT NULL",
			value: null,
			type: "and",
		});
		return this;
	}

	/**
	 * `col >= lo AND col <= hi` — the idiomatic time-range helper for `ts`.
	 * Emitted as two scalar predicates (TDengine's operator set is covered by the
	 * `>=` / `<=` allowlist; no `BETWEEN` keyword is introduced).
	 */
	whereBetween(column: string, range: readonly [EonScalar, EonScalar]): this {
		this.#cachedExec = undefined;
		this.#wheres.push({ column, operator: ">=", value: range[0], type: "and" });
		this.#wheres.push({ column, operator: "<=", value: range[1], type: "and" });
		return this;
	}

	#pushWhere(type: "and" | "or", args: WhereArgs): this {
		this.#cachedExec = undefined;
		if (args.length === 2) {
			const [column, value] = args;
			this.#wheres.push(this.#nullFold(column, "=", value, type));
		} else {
			const [column, operator, value] = args;
			// A 3-arg call whose value is runtime-`undefined` (a JS caller, or an
			// `any` leak — `EonWhereValue` excludes `undefined`, so strict TS callers
			// are already blocked) must NOT be reinterpreted as `col = <operator>`.
			if (value === undefined) {
				throw new Error(
					"[E_EON_INVALID_VALUE] where(column, operator, value): the value is undefined — pass a concrete value, or use whereNull()/whereNotNull() for NULL comparisons.",
				);
			}
			this.#wheres.push(this.#nullFold(column, operator, value, type));
		}
		return this;
	}

	/**
	 * Fold a `null` equality/inequality into `IS NULL` / `IS NOT NULL`, mirroring
	 * Knex/Lucid — `where(col, null)` never means `col = NULL` (which matches no
	 * row in SQL); a caller who wants that literal has no valid use for it.
	 */
	#nullFold(
		column: string,
		operator: string,
		value: EonWhereValue,
		type: "and" | "or",
	): WhereSpec {
		if (value === null && (operator === "=" || operator === "IS NULL")) {
			return { column, operator: "IS NULL", value: null, type };
		}
		if (value === null && (operator === "!=" || operator === "<>")) {
			return { column, operator: "IS NOT NULL", value: null, type };
		}
		return { column, operator, value, type };
	}

	// ─── Projection ───

	/** Replace the SELECT list (bare columns, function items, pseudo-columns). */
	select(items: readonly EonSelectItem[]): this {
		this.#cachedExec = undefined;
		this.#select.length = 0;
		this.#select.push(...items);
		return this;
	}

	// ─── Window ───

	/** `INTERVAL(value[, offset])`. Duration tokens validated in Rust. */
	interval(value: string, offset?: string): this {
		this.#cachedExec = undefined;
		this.#interval = offset === undefined ? value : { value, offset };
		return this;
	}

	/** `SLIDING(value)` — requires an `interval`. */
	sliding(value: string): this {
		this.#cachedExec = undefined;
		this.#sliding = value;
		return this;
	}

	/**
	 * `FILL(mode[, ...values])` — requires an `interval`; `values` only for
	 * `value` mode.
	 *
	 * TDengine additionally requires a **bounded time range** alongside `FILL`:
	 * without one the server answers `9787` ("Start(end) time of query range
	 * required or time range too large"), because filling gaps has no meaning
	 * over an unbounded window. Pair it with {@link whereBetween} on the
	 * timestamp column. Not validated here — the bound may legitimately come
	 * from any combination of predicates, and rejecting a valid query would be
	 * worse than the server's own error.
	 */
	fill(mode: EonFillMode, ...values: readonly EonScalar[]): this {
		this.#cachedExec = undefined;
		this.#fill = { mode, values };
		return this;
	}

	/** `PARTITION BY col[, col]` — tags are quoted; `tbname` passes verbatim. */
	partitionBy(...columns: readonly string[]): this {
		this.#cachedExec = undefined;
		this.#partitionBy.push(...columns);
		return this;
	}

	// ─── Ordering / paging ───

	/** `ORDER BY col [asc|desc]` (default `asc`). */
	orderBy(column: string, direction: EonOrderDirection = "asc"): this {
		this.#cachedExec = undefined;
		this.#orderBy.push({ column, direction });
		return this;
	}

	/** `LIMIT n` — `n` must be a non-negative safe integer. */
	limit(n: number): this {
		if (!Number.isSafeInteger(n) || n < 0) {
			throw new Error(
				`[E_EON_INVALID_LIMIT] limit must be a non-negative safe integer, got ${n}; a NaN/Infinity would silently drop the LIMIT (full scan).`,
			);
		}
		this.#cachedExec = undefined;
		this.#limit = n;
		return this;
	}

	/** `OFFSET m` — requires a `limit`; `m` must be a non-negative safe integer. */
	offset(m: number): this {
		if (!Number.isSafeInteger(m) || m < 0) {
			throw new Error(
				`[E_EON_INVALID_OFFSET] offset must be a non-negative safe integer, got ${m}.`,
			);
		}
		this.#cachedExec = undefined;
		this.#offset = m;
		return this;
	}

	// ─── Terminals ───

	/** Build the `{ sql, params }` pair for debugging (params is always empty). */
	toSQL(): { sql: string; params: unknown[] } {
		const compiled = compileStatementNative(this.#buildSpec());
		const [sql] = compiled.statements;
		if (sql === undefined) {
			throw new Error(
				"[E_EON_COMPILE_EMPTY] the compiler returned no SQL statement",
			);
		}
		return { sql, params: compiled.params };
	}

	/**
	 * Execute and return all matching rows. Memoised: multiple awaits, `.then`
	 * probes, `Promise.resolve(query)` — all share one round-trip. Call the query
	 * afresh (a new builder) to re-execute.
	 */
	exec(): Promise<TPoint[]> {
		this.#cachedExec ??= this.#runSpec(this.#buildSpec());
		return this.#cachedExec;
	}

	/** Alias of {@link exec}. */
	all(): Promise<TPoint[]> {
		return this.exec();
	}

	/** Execute with an implicit `LIMIT 1` and return the first row, or `null`. */
	async first(): Promise<TPoint | null> {
		const rows = await this.#runSpec({ ...this.#buildSpec(), limit: 1 });
		return rows[0] ?? null;
	}

	/**
	 * Thenable: `await query` runs `exec()`. This is the documented ergonomic
	 * (Lucid / atlas parity) — the `then` member IS the public API, so the
	 * `noThenProperty` lint is suppressed rather than refactored away.
	 */
	// biome-ignore lint/suspicious/noThenProperty: the thenable IS the public API — `await query` is the documented ergonomic (atlas ModelQuery parity); removing `.then` breaks every `await query` call site.
	then<TResult1 = TPoint[], TResult2 = never>(
		onfulfilled?:
			| ((value: TPoint[]) => TResult1 | PromiseLike<TResult1>)
			| null
			| undefined,
		onrejected?:
			| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
			| null
			| undefined,
	): Promise<TResult1 | TResult2> {
		return this.exec().then(onfulfilled, onrejected);
	}

	#buildSpec(): SelectSpec {
		return {
			kind: "select",
			table: this.#table,
			select: this.#select.map((item) => toSelectItemSpec(item)),
			wheres: this.#wheres,
			partitionBy: this.#partitionBy,
			interval: this.#interval,
			sliding: this.#sliding,
			fill: this.#fill,
			orderBy: this.#orderBy,
			limit: this.#limit,
			offset: this.#offset,
			literal: true,
		};
	}

	async #runSpec(spec: SelectSpec): Promise<TPoint[]> {
		const compiled = compileStatementNative(spec);
		const [sql] = compiled.statements;
		if (sql === undefined) {
			throw new Error(
				"[E_EON_COMPILE_EMPTY] the compiler returned no SQL statement",
			);
		}
		// The literal-read contract: a builder SELECT must compile param-free, so
		// running it through the literal-only `query(sql)` is safe. A non-empty
		// `params` means literal mode did not hold — fail loud rather than run a
		// statement whose `?` placeholders the connection would silently ignore.
		if (compiled.params.length > 0) {
			throw new Error(
				"[E_EON_UNEXPECTED_PARAMS] a time-series builder SELECT must compile to literal-only SQL, but the compiler returned bound params — literal-mode regression",
			);
		}
		const rawRows = await this.#conn.query<Record<string, unknown>>(sql);
		return this.#mapRows(rawRows);
	}

	/**
	 * Map raw rows to points: the hydrate closure revives declared columns
	 * (bigint / timestamp → `bigint`) by metadata; any remaining key (a window
	 * pseudo-column or aggregate alias, not a declared column) is attached raw —
	 * the atlas `setExtra` escape for raw projections.
	 */
	#mapRows(rawRows: readonly Record<string, unknown>[]): TPoint[] {
		return rawRows.map((row) => {
			const point = this.#hydrate(row);
			for (const key of Object.keys(row)) {
				if (!this.#knownColumns.has(key)) {
					// `defineProperty`, not `Reflect.set`/assignment: a raw column or
					// alias literally named `__proto__`/`constructor` would otherwise
					// invoke the inherited accessor and re-parent `point`. This defines
					// an own data property under the exact key instead.
					Object.defineProperty(point, key, {
						value: row[key],
						writable: true,
						enumerable: true,
						configurable: true,
					});
				}
			}
			return point;
		});
	}
}

function toSelectItemSpec(item: EonSelectItem): SelectItemSpec {
	if (typeof item === "string") {
		return item;
	}
	if ("pseudo" in item) {
		return { pseudo: item.pseudo, alias: item.as };
	}
	return { function: item.fn, column: item.column, alias: item.as };
}
