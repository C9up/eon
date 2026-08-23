/**
 * WebSocket implementation of `EonConnection` over `@tdengine/websocket` 3.5.0
 * (ws-only via taosAdapter — no libtaos, no native FFI, D1). The spike-proven
 * recipe: `WSConfig` + setters → `sqlConnect`; cursor-decode SELECT rows into
 * column-name-keyed objects; TIMESTAMP / BIGINT stay `BigInt` epoch values (no
 * lossy `Date` coercion — the consuming ORM layer decides, D4).
 */

import {
	destroy,
	Precision,
	SchemalessProto,
	type StmtBindParams,
	sqlConnect,
	type TDengineMeta,
	TDWebSocketClientError,
	WSConfig,
	type WSRows,
	type WsSql,
} from "@tdengine/websocket";
import type { EonConnectionConfig } from "./config.js";
import {
	type EonBoundColumn,
	type EonColumnarIngest,
	type EonConnection,
	EonConnectionError,
	type EonLineProtocol,
	type EonSchemalessOptions,
	type EonSchemalessPrecision,
} from "./EonConnection.js";

/** Map an agnostic line-protocol name to the connector's `SchemalessProto`. */
function toSchemalessProto(protocol: EonLineProtocol): SchemalessProto {
	switch (protocol) {
		case "influxdb":
			return SchemalessProto.InfluxDBLineProtocol;
		case "opentsdb-telnet":
			return SchemalessProto.OpenTSDBTelnetLineProtocol;
		case "opentsdb-json":
			return SchemalessProto.OpenTSDBJsonFormatProtocol;
	}
}

/** Map an agnostic precision to the connector's `Precision`. */
function toPrecision(precision: EonSchemalessPrecision): Precision {
	switch (precision) {
		case "hours":
			return Precision.HOURS;
		case "minutes":
			return Precision.MINUTES;
		case "seconds":
			return Precision.SECONDS;
		case "milliseconds":
			return Precision.MILLI_SECONDS;
		case "microseconds":
			return Precision.MICRO_SECONDS;
		case "nanoseconds":
			return Precision.NANO_SECONDS;
	}
}

/**
 * Bind one whole column (SoA) into a `StmtBindParams` via the setter its kind
 * selects. The connector's setters take the entire column array in one call —
 * this is the columnar boundary the locked 58.0 contract mandates (never a
 * per-row object). The setter params are typed `any[]` by the connector; we
 * pass our `unknown[]` column verbatim (no `any` enters eon).
 */
function bindColumn(params: StmtBindParams, column: EonBoundColumn): void {
	const v = column.values;
	switch (column.kind) {
		case "timestamp":
			params.setTimestamp(v);
			return;
		case "bool":
			params.setBoolean(v);
			return;
		case "tinyInt":
			params.setTinyInt(v);
			return;
		case "smallInt":
			params.setSmallInt(v);
			return;
		case "int":
			params.setInt(v);
			return;
		case "bigInt":
			params.setBigint(v);
			return;
		case "float":
			params.setFloat(v);
			return;
		case "double":
			params.setDouble(v);
			return;
		case "varchar":
			params.setVarchar(v);
			return;
		case "nchar":
			params.setNchar(v);
			return;
		case "varbinary":
			params.setVarBinary(v);
			return;
		case "json":
			params.setJson(v);
			return;
		case "decimal":
			params.setDecimal(v);
			return;
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

/** Wrap a connector failure as an `EonConnectionError`, preserving `.code`. */
function wrapError(cause: unknown, message: string): EonConnectionError {
	if (cause instanceof TDWebSocketClientError) {
		return new EonConnectionError(`${message}: ${cause.message}`, {
			cause,
			code: cause.code,
		});
	}
	return new EonConnectionError(message, { cause });
}

/**
 * Race a connect against an overall deadline so a socket that accepts TCP but
 * stalls the WS handshake can't wedge boot forever (`WSConfig.setTimeOut` bounds
 * requests, not necessarily the handshake). A timeout rejects → the retry loop
 * treats it like any other connect failure. The timer is always cleared.
 */
async function withConnectTimeout(
	connect: Promise<WsSql>,
	ms: number | undefined,
): Promise<WsSql> {
	if (ms === undefined) return connect;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(
				new EonConnectionError(
					`eon: connect did not complete within ${ms}ms (WS handshake stalled)`,
				),
			);
		}, ms);
	});
	// If the deadline wins the race, the connect promise is abandoned but still
	// pending — a handshake that completes late resolves to a live WsSql nobody
	// holds or closes (an orphaned socket per timed-out attempt, worst under a
	// retry loop). Tear it down when it eventually settles.
	connect
		.then((ws) => {
			if (timedOut) void ws.close().catch(() => {});
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
async function connectWithRetry(config: EonConnectionConfig): Promise<WsSql> {
	if (typeof config.url !== "string" || config.url.trim() === "") {
		throw new EonConnectionError(
			"eon: connection 'url' is required and must be a non-empty WebSocket URL (e.g. 'ws://localhost:6041')",
		);
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
			const conf = new WSConfig(config.url);
			if (config.user !== undefined) conf.setUser(config.user);
			if (config.password !== undefined) conf.setPwd(config.password);
			if (config.database !== undefined) conf.setDb(config.database);
			if (config.token !== undefined) conf.setToken(config.token);
			if (config.timeoutMs !== undefined) conf.setTimeOut(config.timeoutMs);
			return await withConnectTimeout(sqlConnect(conf), config.timeoutMs);
		} catch (error) {
			lastError = error;
			if (attempt === attempts - 1) break;
			await delay(Math.min(baseBackoff * 2 ** attempt, MAX_BACKOFF_MS));
		}
	}
	throw wrapError(
		lastError,
		`eon: failed to connect to '${config.url}' after ${attempts} attempt(s)`,
	);
}

/**
 * Tear down the connector's PROCESS-GLOBAL resources.
 *
 * `EonConnection.close()` closes one connection and deliberately leaves this
 * alone (D6). But the connector keeps process-wide handles alive, so closing
 * every connection is NOT enough for Node to exit — a service that shuts down
 * cleanly would hang forever. Call this once, after the last connection is
 * closed; `EonProvider.shutdown()` already does.
 *
 * Reversible: a later `connectWsEon` reconnects normally (verified against a
 * live server), so a boot → shutdown → boot cycle is fine.
 */
export async function destroyEonConnector(): Promise<void> {
	await destroy();
}

/**
 * Connect to TDengine over WebSocket and return a transport-agnostic
 * `EonConnection`. Credentials go through `WSConfig` setters, never embedded in
 * the URL. The returned object is a single long-lived connection (no pool, D7).
 */
export async function connectWsEon(
	config: EonConnectionConfig,
): Promise<EonConnection> {
	const wsSql = await connectWithRetry(config);

	let closed = false;
	// Serialize every operation on the single shared socket. `@tdengine/websocket`
	// multiplexes request/response over one connection, so two overlapping calls
	// could interleave frames and desync responses (rows attributed to the wrong
	// query). A promise-chain mutex runs each op strictly after the previous one
	// settles — success or failure (D7: one long-lived connection, no pool).
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
		if (closed) throw new EonConnectionError("eon: connection is closed");
	}

	async function execStatement(sql: string): Promise<{ rowsAffected: number }> {
		ensureOpen();
		return serialize(async () => {
			try {
				const result = await wsSql.exec(sql);
				return { rowsAffected: result.getAffectRows() ?? 0 };
			} catch (error) {
				throw wrapError(error, `eon: exec failed for [${sqlHead(sql)}]`);
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
			let rows: WSRows;
			try {
				rows = await wsSql.query(sql);
			} catch (error) {
				throw wrapError(error, `eon: query failed for [${sqlHead(sql)}]`);
			}
			let out: Record<string, unknown>[];
			try {
				// getMeta(): {name,type,length}[] | null — column order matches getData().
				const meta = rows.getMeta() ?? [];
				out = [];
				while (await rows.next()) {
					// A non-empty cursor with empty column metadata would decode every
					// row to `{}` — silent data loss. Fail loud instead.
					if (meta.length === 0) {
						throw new Error(
							`[E_EON_DECODE] query returned rows but no column metadata for [${sqlHead(sql)}]; cannot decode`,
						);
					}
					// getData() is typed `any[]` by the connector; funnel it through
					// `unknown[]` so no `any` leaks into eon (AC9). Values stay
					// connector-native — TIMESTAMP/BIGINT are BigInt (D4).
					const row: unknown[] = rows.getData() ?? [];
					const record: Record<string, unknown> = {};
					meta.forEach((column: TDengineMeta, index: number) => {
						record[column.name] = row[index];
					});
					out.push(record);
				}
			} catch (error) {
				// The decode error is the real one — close best-effort so a failing
				// close on the dead socket never masks it.
				await rows.close().catch(() => {});
				throw wrapError(error, `eon: query failed for [${sqlHead(sql)}]`);
			}
			// Decode succeeded: here a close failure IS the primary error, surface it.
			try {
				await rows.close();
			} catch (error) {
				throw wrapError(
					error,
					`eon: cursor close failed for [${sqlHead(sql)}]`,
				);
			}
			return out;
		});
	}

	async function pingServer(): Promise<void> {
		ensureOpen();
		return serialize(async () => {
			let rows: WSRows;
			try {
				rows = await wsSql.query("SELECT server_version()");
			} catch (error) {
				throw wrapError(error, "eon: ping failed");
			}
			try {
				await rows.close();
			} catch (error) {
				throw wrapError(error, "eon: ping failed");
			}
		});
	}

	/**
	 * Columnar STMT bulk ingest (58.4). One `stmtInit` + `prepare` reused across
	 * every child batch: `setTableName` → columnar `setTags` → columnar `bind` →
	 * `batch` → `exec`. The STMT handle is always released in `finally`, even on
	 * the error path (AC6). Serialized on the shared socket like every other op.
	 */
	async function ingestColumnar(
		request: EonColumnarIngest,
	): Promise<{ rowsAffected: number }> {
		ensureOpen();
		return serialize(async () => {
			// stmtInit sits before the try/finally that owns the handle; wrap its
			// failure too so a stmtInit error carries the EonConnectionError code
			// like every other op (it acquires no handle, so there is nothing to
			// release on this path).
			const stmt = await wsSql.stmtInit().catch((error) => {
				throw wrapError(error, "eon: columnar STMT ingest failed (stmtInit)");
			});
			try {
				await stmt.prepare(request.sql);
				let rowsAffected = 0;
				for (const child of request.children) {
					await stmt.setTableName(child.table);
					const tagParams = stmt.newStmtParam();
					for (const tag of child.tags) bindColumn(tagParams, tag);
					await stmt.setTags(tagParams);
					const colParams = stmt.newStmtParam();
					for (const column of child.columns) bindColumn(colParams, column);
					await stmt.bind(colParams);
					await stmt.batch();
					await stmt.exec();
					rowsAffected += stmt.getLastAffected() ?? 0;
				}
				return { rowsAffected };
			} catch (error) {
				throw wrapError(error, "eon: columnar STMT ingest failed");
			} finally {
				// Release the STMT resource unconditionally; a close failure here must
				// not mask a real ingest error, so it is swallowed best-effort.
				await stmt.close().catch(() => {});
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
				await wsSql.schemalessInsert(
					[...lines],
					toSchemalessProto(options?.protocol ?? "influxdb"),
					toPrecision(options?.precision ?? "milliseconds"),
					options?.ttl ?? 0,
				);
			} catch (error) {
				throw wrapError(error, "eon: schemaless insert failed");
			}
		});
	}

	async function closeConnection(): Promise<void> {
		if (closed) return; // idempotent — double-close is a no-op, not a connector error
		closed = true;
		// Drain any in-flight op (enqueued before `closed` was set) then close.
		return serialize(async () => {
			try {
				await wsSql.close();
			} catch (error) {
				throw wrapError(error, "eon: close failed");
			}
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
