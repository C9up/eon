/**
 * WebSocket implementation of `EonConnection`, over eon's own taosAdapter
 * client (`./taos/`, on Node's global `WebSocket` — no driver package, no
 * native FFI, D1). SELECT rows decode into column-name-keyed objects;
 * TIMESTAMP / BIGINT stay `BigInt` epoch values (no lossy `Date` coercion —
 * the consuming ORM layer decides, D4); a SQL NULL is `null` for every type.
 */

import type { Exception } from "@c9up/flare";
import { E_EON_CLOSED, E_EON_CONNECT, E_EON_DECODE } from "../errors.js";
import type { EonConnectionConfig } from "./config.js";
import type {
	EonColumnarIngest,
	EonConnection,
	EonLineProtocol,
	EonSchemalessOptions,
	EonSchemalessPrecision,
} from "./EonConnection.js";
import { redactUrl } from "./redact.js";
import { defineColumn } from "./row.js";
import { inContext } from "./taos/errors.js";
import { TaosSql } from "./taos/sql.js";

/** taosAdapter's code for each line protocol. */
function toSchemalessProto(protocol: EonLineProtocol): 1 | 2 | 3 {
	switch (protocol) {
		case "influxdb":
			return 1;
		case "opentsdb-telnet":
			return 2;
		case "opentsdb-json":
			return 3;
	}
}

/** taosAdapter's spelling of each precision. */
function toPrecision(precision: EonSchemalessPrecision): string {
	switch (precision) {
		case "hours":
			return "h";
		case "minutes":
			return "m";
		case "seconds":
			return "s";
		case "milliseconds":
			return "ms";
		case "microseconds":
			return "u";
		case "nanoseconds":
			return "ns";
	}
}

const DEFAULT_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Redact a statement for error/log messages: keep the leading clause (verb +
 * quoted identifiers) but drop any value-bearing tail (`VALUES` / `WHERE` /
 * `SET`, or a parenthesised list), so literal measurements/tags never leak into
 * log sinks. Identifiers are backtick-quoted names, not sensitive data.
 */
function sqlHead(sql: string): string {
	const cut = sql.search(/\b(?:VALUES|WHERE|SET)\b|\(/i);
	const head = (cut === -1 ? sql : sql.slice(0, cut)).trim();
	return head.length > 80 ? `${head.slice(0, 80)}…` : head;
}

/**
 * Where echoed data can start in a server message: TDengine quotes the SQL
 * after the error point (`syntax error near '…'`) and prints a refused
 * schemaless point after `key:`; any line-protocol fragment holds `=`.
 */
const ECHOED_DATA = /['"`=]|\bkey:|\bnear\b/i;

/** The value-free head of a server message. */
function serverReason(message: string): string {
	const cut = message.search(ECHOED_DATA);
	const head = (cut === -1 ? message : message.slice(0, cut))
		.replace(/[\s,:;(]+$/, "")
		.trim();
	return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}

/**
 * `inContext` for an operation that carries data (a statement, a batch, a
 * schemaless line). Only the value-free head of the server's message reaches
 * `.message`, which is what log sinks see; the full text stays on `.cause`.
 */
function dataError(cause: unknown, message: string): Exception {
	return inContext(cause, message, serverReason);
}

/**
 * Race a connect against an overall deadline so a socket that accepts TCP but
 * stalls the WS handshake — or answers it and then never `conn` — can't wedge
 * boot forever. A timeout rejects → the retry loop treats it like any other
 * connect failure. The timer is always cleared.
 */
async function withConnectTimeout(
	connect: Promise<TaosSql>,
	ms: number | undefined,
): Promise<TaosSql> {
	if (ms === undefined) return connect;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(
				new E_EON_CONNECT([
					`eon: connect did not complete within ${ms}ms (WS handshake stalled)`,
				]),
			);
		}, ms);
	});
	// If the deadline wins the race, the connect promise is abandoned but still
	// pending — a handshake that completes late resolves to a live client nobody
	// holds or closes (an orphaned socket per timed-out attempt, worst under a
	// retry loop). Tear it down when it eventually settles.
	connect
		.then((ws) => {
			if (timedOut) ws.close();
		})
		.catch(() => {});
	try {
		return await Promise.race([connect, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Open the WS connection, retrying only the INITIAL connect (docker/k8s
 * cold-start race — D7 / atlas `createNapiConnection` parity). Backoff grows
 * exponentially, capped at 30s. This is NOT a per-query reconnect.
 */
async function connectWithRetry(config: EonConnectionConfig): Promise<TaosSql> {
	if (typeof config.url !== "string" || config.url.trim() === "") {
		throw new E_EON_CONNECT([
			"eon: connection 'url' is required and must be a non-empty WebSocket URL (e.g. 'ws://localhost:6041')",
		]);
	}
	// Clamp: a negative, fractional, or NaN `connectRetries` must still make one
	// attempt, never zero — a zero-iteration loop would skip connecting entirely
	// and then throw with an `undefined` cause, hiding the real config mistake.
	// `Math.max(0, NaN)` is `NaN`, so guard non-finite before the arithmetic.
	const configured = config.connectRetries;
	const retries =
		typeof configured === "number" && Number.isFinite(configured)
			? Math.max(0, Math.floor(configured))
			: 0;
	const attempts = retries + 1;
	// Clamp like `connectRetries`: a NaN/negative backoff (`??` only catches
	// null/undefined) would make `delay()` fire immediately, turning the retry
	// loop into a tight no-delay hammer against the server.
	const configuredBackoff = config.connectBackoffMs;
	const baseBackoff =
		typeof configuredBackoff === "number" && Number.isFinite(configuredBackoff)
			? Math.max(0, configuredBackoff)
			: DEFAULT_BACKOFF_MS;
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await withConnectTimeout(
				TaosSql.connect({
					url: config.url,
					user: config.user,
					password: config.password,
					database: config.database,
					token: config.token,
					timeoutMs: config.timeoutMs,
				}),
				config.timeoutMs,
			);
		} catch (error) {
			lastError = error;
			if (attempt === attempts - 1) break;
			await delay(Math.min(baseBackoff * 2 ** attempt, MAX_BACKOFF_MS));
		}
	}
	throw inContext(
		lastError,
		`eon: failed to connect to '${redactUrl(config.url)}' after ${attempts} attempt(s)`,
	);
}

/**
 * Release process-wide transport resources — there are none any more.
 *
 * The previous driver kept a process-global connection pool alive, so closing
 * every connection did not let Node exit and this had to run on shutdown. eon's
 * own client owns nothing beyond each connection's socket, which `close()`
 * releases. Kept, as a no-op, so code that calls it (EonProvider, apps) keeps
 * working.
 */
export async function destroyEonConnector(): Promise<void> {}

/**
 * Connect to TDengine over WebSocket and return a transport-agnostic
 * `EonConnection`. Credentials belong in `user`/`password`/`token`, which go
 * in the `conn` request (the token in the URL's query); any the URL carries
 * are masked in error messages. The returned object is a single long-lived connection (no pool, D7).
 */
export async function connectWsEon(
	config: EonConnectionConfig,
): Promise<EonConnection> {
	const client = await connectWithRetry(config);

	let closed = false;
	// Serialize every operation on the single shared socket. The client matches
	// replies to requests by id, but a query is several round trips (query,
	// fetch, fetch…, free) and a STMT ingest a sequence (init, prepare, bind,
	// exec, close); running them one at a time keeps each sequence whole and the
	// server's per-connection state (USE) predictable. A promise-chain mutex runs
	// each op strictly after the previous one settles — success or failure (D7:
	// one long-lived connection, no pool).
	let queue: Promise<unknown> = Promise.resolve();
	function serialize<T>(op: () => Promise<T>): Promise<T> {
		const run = queue.then(op, op);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Reject use-after-close loudly instead of dereferencing the dead handle. */
	function ensureOpen(): void {
		if (closed) throw new E_EON_CLOSED(["eon: connection is closed"]);
	}

	async function execStatement(sql: string): Promise<{ rowsAffected: number }> {
		ensureOpen();
		return serialize(async () => {
			try {
				const result = await client.exec(sql);
				return { rowsAffected: result.affectedRows };
			} catch (error) {
				throw dataError(error, `eon: exec failed for [${sqlHead(sql)}]`);
			}
		});
	}

	// Overload: the public seam is generic (`query<T>(): Promise<T[]>`), the
	// implementation decodes into `Record<string, unknown>[]`. The overload lets
	// the concrete impl satisfy the generic signature with no `as` cast (AC9) —
	// narrowing to `T` is the caller's assertion at the call site.
	function runQuery<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	async function runQuery(sql: string): Promise<Record<string, unknown>[]> {
		ensureOpen();
		return serialize(async () => {
			let result: Awaited<ReturnType<TaosSql["query"]>>;
			try {
				result = await client.query(sql);
			} catch (error) {
				throw dataError(error, `eon: query failed for [${sqlHead(sql)}]`);
			}
			// Rows with no column metadata would each decode to `{}` — silent
			// data loss. Fail loud instead.
			if (result.rows.length > 0 && result.columns.length === 0) {
				throw new E_EON_DECODE([
					`query returned rows but no column metadata for [${sqlHead(sql)}]; cannot decode`,
				]);
			}
			return result.rows.map((row) => {
				const record: Record<string, unknown> = {};
				result.columns.forEach((column, index) => {
					defineColumn(record, column.name, row[index] ?? null);
				});
				return record;
			});
		});
	}

	async function pingServer(): Promise<void> {
		ensureOpen();
		return serialize(async () => {
			try {
				await client.query("SELECT server_version()");
			} catch (error) {
				throw inContext(error, "eon: ping failed");
			}
		});
	}

	/**
	 * Columnar STMT bulk ingest (58.4) over stmt2. One `stmt2_init` + `prepare`
	 * reused across every child batch: one bind frame per child (table name,
	 * columnar tags, columnar values), then `exec`. The statement is closed in
	 * every case, even on the error path (AC6). Serialized on the shared socket
	 * like every other op.
	 */
	async function ingestColumnar(
		request: EonColumnarIngest,
	): Promise<{ rowsAffected: number }> {
		ensureOpen();
		return serialize(async () => {
			try {
				const rowsAffected = await client.stmt2(
					request.sql,
					request.children.map((child) => ({
						name: child.table,
						tags: child.tags,
						columns: child.columns,
					})),
					request.stable,
				);
				return { rowsAffected };
			} catch (error) {
				throw dataError(error, "eon: columnar STMT ingest failed");
			}
		});
	}

	async function schemalessInsert(
		lines: readonly string[],
		options?: EonSchemalessOptions,
	): Promise<void> {
		ensureOpen();
		return serialize(async () => {
			try {
				await client.schemaless(
					lines,
					toSchemalessProto(options?.protocol ?? "influxdb"),
					toPrecision(options?.precision ?? "milliseconds"),
					options?.ttl ?? 0,
				);
			} catch (error) {
				throw dataError(error, "eon: schemaless insert failed");
			}
		});
	}

	async function closeConnection(): Promise<void> {
		if (closed) return; // idempotent — double-close is a no-op, not an error
		closed = true;
		// Drain any in-flight op (enqueued before `closed` was set) then close.
		return serialize(async () => {
			client.close();
		});
	}

	return {
		transport: "websocket",
		exec: execStatement,
		query: runQuery,
		ping: pingServer,
		ingestColumnar,
		schemaless: schemalessInsert,
		close: closeConnection,
	};
}
