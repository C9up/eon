/**
 * `FakeEonConnection` — a hand-rolled in-memory `EonConnection` for fast,
 * deterministic unit tests without a live TDengine (58.6). The atlas analogue is
 * a REAL in-memory SQLite (`testing/TestDatabase.ts`); TDengine has no embeddable
 * engine, so this is a deliberately narrow test double, NOT a SQL engine.
 *
 * ── Scope (named boundary) ─────────────────────────────────────────────────
 *  - `exec(sql)` RECORDS every statement (assertable via {@link statements}) and,
 *    for recognised `CREATE TABLE`/`CREATE STABLE`/`INSERT` forms, updates a
 *    per-table row store.
 *  - `query(sql)` answers ONLY flat `SELECT [cols] FROM t [WHERE col <op> val]
 *    [LIMIT n]`. Windowed / aggregate SQL (`INTERVAL`/`FILL`/`PARTITION BY`/
 *    `avg(...)`) is NOT interpreted — it throws `E_EON_FAKE_UNSUPPORTED` pointing
 *    the caller to the docker integration harness (`describeIfTdengine`).
 *  - `ingestColumnar`/`schemaless` are STMT/line-protocol paths that need a live
 *    connector — they throw `E_EON_FAKE_UNSUPPORTED`. (The 58.6 factory persists
 *    through literal `exec` INSERTs, which the store DOES handle.)
 *  - `ping()`/`close()` are no-ops.
 */

import {
	type EonColumnarIngest,
	type EonConnection,
	EonConnectionError,
	type EonSchemalessOptions,
} from "../connection/EonConnection.js";

type Row = Record<string, unknown>;

const WINDOWED = /\b(INTERVAL|FILL|PARTITION\s+BY|SLIDING)\b/i;
/** TDengine's "Table already exists" error code. */
const TABLE_ALREADY_EXISTS = 1539;
const IF_NOT_EXISTS = /\bIF\s+NOT\s+EXISTS\b/i;
/** TDengine's "Table does not exist" error code. */
const TABLE_DOES_NOT_EXIST = 9731;
const IF_EXISTS = /\bIF\s+EXISTS\b/i;

export class FakeEonConnection implements EonConnection {
	readonly transport: "fake" = "fake";
	/** Every `exec`ed statement, in order — assert against this in tests. */
	readonly statements: string[] = [];
	readonly #store = new Map<string, Row[]>();

	async exec(sql: string): Promise<{ rowsAffected: number }> {
		this.statements.push(sql);
		const trimmed = sql.trim();
		if (/^CREATE\s+(STABLE|TABLE)\b/i.test(trimmed)) {
			const table = extractCreateTarget(trimmed);
			if (table !== undefined) {
				// A real server REJECTS a duplicate CREATE that omits IF NOT EXISTS,
				// with code 1539 — the atomic "one winner" primitive the migration
				// lock is built on (measured against a live 3.3.5.0 server: 12 racing
				// connections, 1 winner, 11 × 1539). The fake has to reject it too,
				// or a lock test would pass here and deadlock against a real server.
				if (this.#store.has(table) && !IF_NOT_EXISTS.test(trimmed)) {
					throw new EonConnectionError(
						`eon: exec failed for [${trimmed}]: Table already exists`,
						{ code: TABLE_ALREADY_EXISTS },
					);
				}
				if (!this.#store.has(table)) this.#store.set(table, []);
			}
			return { rowsAffected: 0 };
		}
		if (/^INSERT\s+INTO\b/i.test(trimmed)) {
			const rows = parseInsert(trimmed);
			if (rows !== undefined) {
				const existing = this.#store.get(rows.table) ?? [];
				existing.push(...rows.rows);
				this.#store.set(rows.table, existing);
				return { rowsAffected: rows.rows.length };
			}
		}
		if (/^DELETE\s+FROM\b/i.test(trimmed)) {
			const affected = this.#applyDelete(trimmed);
			return { rowsAffected: affected };
		}
		// DROP / USE / other DDL: recorded, no store change.
		if (/^DROP\s+(STABLE|TABLE)\b/i.test(trimmed)) {
			const table = extractDropTarget(trimmed);
			if (table !== undefined) {
				// Mirror of the CREATE rule above: a real server rejects a DROP that
				// omits IF EXISTS when the table is absent (code 9731, measured on
				// 3.3.5.0). `forceUnlock` reads exactly that code to report whether a
				// lock was actually held.
				if (!this.#store.has(table) && !IF_EXISTS.test(trimmed)) {
					throw new EonConnectionError(
						`eon: exec failed for [${trimmed}]: Table does not exist`,
						{ code: TABLE_DOES_NOT_EXIST },
					);
				}
				this.#store.delete(table);
			}
		}
		return { rowsAffected: 0 };
	}

	query<T = Row>(sql: string): Promise<T[]>;
	async query(sql: string): Promise<Row[]> {
		const trimmed = sql.trim();
		if (WINDOWED.test(trimmed) || hasAggregate(trimmed)) {
			throw new Error(
				`[E_EON_FAKE_UNSUPPORTED] FakeEonConnection answers only flat SELECT; windowed/aggregate SQL needs a live TDengine (use describeIfTdengine). Query: ${trimmed}`,
			);
		}
		const parsed = parseSelect(trimmed);
		if (parsed === undefined) {
			throw new Error(
				`[E_EON_FAKE_UNSUPPORTED] FakeEonConnection could not parse this SELECT: ${trimmed}`,
			);
		}
		let rows = [...(this.#store.get(parsed.table) ?? [])];
		if (parsed.where !== undefined) {
			const { column, op, value } = parsed.where;
			rows = rows.filter((r) => compareOp(r[column], op, value));
		}
		if (parsed.limit !== undefined) rows = rows.slice(0, parsed.limit);
		if (parsed.columns === "*") return rows;
		const cols = parsed.columns;
		return rows.map((r) => {
			const projected: Row = {};
			for (const c of cols) projected[c] = r[c];
			return projected;
		});
	}

	async ingestColumnar(
		request: EonColumnarIngest,
	): Promise<{ rowsAffected: number }> {
		void request;
		throw new Error(
			"[E_EON_FAKE_UNSUPPORTED] FakeEonConnection has no STMT columnar path; test bulk ingest against a live TDengine (describeIfTdengine).",
		);
	}

	async schemaless(
		lines: readonly string[],
		options?: EonSchemalessOptions,
	): Promise<void> {
		void lines;
		void options;
		throw new Error(
			"[E_EON_FAKE_UNSUPPORTED] FakeEonConnection has no line-protocol path; test schemaless ingest against a live TDengine (describeIfTdengine).",
		);
	}

	async ping(): Promise<void> {}
	async close(): Promise<void> {}

	/** Clear recorded statements and the row store. */
	reset(): void {
		this.statements.length = 0;
		this.#store.clear();
	}

	/** Read the current rows for a table (a copy) — a test-inspection helper. */
	rows(table: string): Row[] {
		return [...(this.#store.get(table) ?? [])];
	}

	#applyDelete(sql: string): number {
		const match =
			/^DELETE\s+FROM\s+`([^`]+)`\s+WHERE\s+`([^`]+)`\s*=\s*(.+)$/i.exec(sql);
		if (match === null) return 0;
		const [, table, column, rawValue] = match;
		if (table === undefined || column === undefined || rawValue === undefined) {
			return 0;
		}
		const value = parseLiteral(rawValue.trim());
		const existing = this.#store.get(table);
		if (existing === undefined) return 0;
		const kept = existing.filter((r) => r[column] !== value);
		this.#store.set(table, kept);
		return existing.length - kept.length;
	}
}

/** Detect a function-call in the SELECT projection (`avg(...)`, `count(*)`, …). */
function hasAggregate(sql: string): boolean {
	const match = /^SELECT\s+(.+?)\s+FROM\b/i.exec(sql);
	if (match === null) return false;
	const projection = match[1] ?? "";
	return /[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(projection);
}

function extractCreateTarget(sql: string): string | undefined {
	const match =
		/^CREATE\s+(?:STABLE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i.exec(
			sql,
		);
	return match?.[1];
}

function extractDropTarget(sql: string): string | undefined {
	const match = /^DROP\s+(?:STABLE|TABLE)\s+(?:IF\s+EXISTS\s+)?`([^`]+)`/i.exec(
		sql,
	);
	return match?.[1];
}

interface ParsedInsert {
	table: string;
	rows: Row[];
}

/** Parse a literal `INSERT` (plain or `USING … TAGS`) into rows keyed by column. */
function parseInsert(sql: string): ParsedInsert | undefined {
	const tableMatch = /^INSERT\s+INTO\s+`([^`]+)`/i.exec(sql);
	const table = tableMatch?.[1];
	if (table === undefined) return undefined;
	// Strip an optional child-create `USING `stb` TAGS (...)` clause.
	const body = sql.replace(/\bUSING\s+`[^`]+`\s+TAGS\s*\([^)]*\)/i, "");
	const colsMatch = /\(([^)]*)\)\s*VALUES/i.exec(body);
	const valuesPart = body.slice(body.search(/VALUES/i) + "VALUES".length);
	if (colsMatch === null) return undefined;
	const columns = (colsMatch[1] ?? "")
		.split(",")
		.map((c) => c.trim().replace(/^`|`$/g, ""));
	const rows: Row[] = [];
	for (const tuple of splitTuples(valuesPart)) {
		const values = splitValues(tuple).map(parseLiteral);
		const row: Row = {};
		columns.forEach((c, i) => {
			row[c] = values[i];
		});
		rows.push(row);
	}
	return { table, rows };
}

interface ParsedSelect {
	columns: "*" | string[];
	table: string;
	where?: { column: string; op: string; value: unknown };
	limit?: number;
}

function parseSelect(sql: string): ParsedSelect | undefined {
	const match =
		/^SELECT\s+(.+?)\s+FROM\s+`([^`]+)`\s*(?:WHERE\s+(.+?))?\s*(?:LIMIT\s+(\d+))?\s*$/i.exec(
			sql,
		);
	if (match === null) return undefined;
	const [, rawCols, table, rawWhere, rawLimit] = match;
	if (rawCols === undefined || table === undefined) return undefined;
	const columns: "*" | string[] =
		rawCols.trim() === "*"
			? "*"
			: rawCols.split(",").map((c) => c.trim().replace(/^`|`$/g, ""));
	const result: ParsedSelect = { columns, table };
	if (rawWhere !== undefined) {
		const clause = rawWhere.trim();
		// A multi-predicate WHERE (`a` = 1 AND `b` = 2) or an unparseable clause
		// (non-backtick column, unknown operator) is NOT supported. Return
		// undefined so the caller throws E_EON_FAKE_UNSUPPORTED rather than
		// silently dropping the predicate and returning every row (fail-loud).
		if (hasBooleanConnector(clause)) return undefined;
		const w = /^`([^`]+)`\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/.exec(clause);
		if (
			w === null ||
			w[1] === undefined ||
			w[2] === undefined ||
			w[3] === undefined
		) {
			return undefined;
		}
		result.where = {
			column: w[1],
			op: w[2],
			value: parseLiteral(w[3].trim()),
		};
	}
	if (rawLimit !== undefined) result.limit = Number(rawLimit);
	return result;
}

/**
 * True if a WHERE clause has a top-level `AND`/`OR` connector (a multi-predicate
 * filter the flat store cannot evaluate). Single-quoted string literals are
 * blanked first so an `AND` inside a value (`'a AND b'`) is not misread.
 */
function hasBooleanConnector(clause: string): boolean {
	const unquoted = clause.replace(/'(?:\\.|[^'\\])*'/g, "''");
	return /\b(?:AND|OR)\b/i.test(unquoted);
}

function compareOp(left: unknown, op: string, right: unknown): boolean {
	switch (op) {
		case "=":
			return left === right;
		case "!=":
		case "<>":
			return left !== right;
		default: {
			const l = Number(left);
			const r = Number(right);
			if (Number.isNaN(l) || Number.isNaN(r)) return false;
			if (op === ">") return l > r;
			if (op === ">=") return l >= r;
			if (op === "<") return l < r;
			if (op === "<=") return l <= r;
			return false;
		}
	}
}

/** Split a `VALUES` clause into per-row tuples, respecting quoted strings. */
function splitTuples(valuesPart: string): string[] {
	const tuples: string[] = [];
	let depth = 0;
	let inString = false;
	let start = -1;
	for (let i = 0; i < valuesPart.length; i++) {
		const ch = valuesPart[i];
		if (inString) {
			if (ch === "\\")
				i++; // skip the escaped char
			else if (ch === "'") inString = false;
			continue;
		}
		if (ch === "'") {
			inString = true;
		} else if (ch === "(") {
			if (depth === 0) start = i + 1;
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0 && start >= 0) {
				tuples.push(valuesPart.slice(start, i));
				start = -1;
			}
		}
	}
	return tuples;
}

/** Split a tuple body into top-level comma-separated value tokens. */
function splitValues(tuple: string): string[] {
	const values: string[] = [];
	let inString = false;
	let current = "";
	for (let i = 0; i < tuple.length; i++) {
		const ch = tuple[i];
		if (inString) {
			current += ch;
			if (ch === "\\") {
				const next = tuple[i + 1];
				if (next !== undefined) {
					current += next;
					i++;
				}
			} else if (ch === "'") {
				inString = false;
			}
			continue;
		}
		if (ch === "'") {
			inString = true;
			current += ch;
		} else if (ch === ",") {
			values.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim().length > 0) values.push(current.trim());
	return values;
}

/** Parse a single SQL literal token back to a JS value (inverse of `render_literal`). */
function parseLiteral(token: string): unknown {
	if (token === "NULL") return null;
	if (token === "true") return true;
	if (token === "false") return false;
	if (token.startsWith("'") && token.endsWith("'")) {
		return token.slice(1, -1).replace(/\\(['\\])/g, "$1");
	}
	const num = Number(token);
	return Number.isNaN(num) ? token : num;
}
