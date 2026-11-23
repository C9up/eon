/**
 * TDengine over taosAdapter's `/ws` endpoint: connect, run SQL, decode
 * results, bind through stmt2, write schemaless lines.
 *
 * The protocol is the one `@tdengine/websocket` 3.5.0 speaks (read from its
 * source): JSON requests for control, a binary `binary_query` (action 6) for
 * SQL whose JSON reply describes the result, binary `fetch_raw_block`
 * (action 7) replies carrying raw blocks, and a binary `stmt2_bind` frame.
 * What it leaves out on purpose: reconnecting and replaying requests (eon
 * keeps one connection and retries only the first connect), connection pools,
 * the stmt1 fallback for servers older than 3.3.6.0, and every process-wide
 * side effect.
 */

import {
	E_EON_BIND,
	E_EON_SERVER_ERROR,
	E_EON_SERVER_VERSION,
} from "../../errors.js";
import { decodeRawBlock, TaosType } from "./block.js";
import { decodeError } from "./errors.js";
import {
	arrayField,
	asWireObject,
	bigintField,
	booleanField,
	numberField,
	stringField,
	type WireObject,
} from "./json.js";
import { TaosSocket, type TaosSocketOptions } from "./socket.js";
import {
	type DecimalShape,
	encodeBind,
	type Stmt2Field,
	type Stmt2Table,
} from "./stmt2.js";
import { resolveTarget } from "./url.js";

const BINARY_QUERY = 6n;
const FETCH_RAW_BLOCK = 7n;
/** The action a TMQ `fetch_raw_data` reply carries. */
const FETCH_RAW_DATA_REPLY = 8n;
/** The version every binary request carries. */
const BINARY_VERSION = 1;
/** stmt2 arrived in TDengine 3.3.6.0. */
const STMT2_MIN_VERSION = [3, 3, 6, 0];

/** Who eon says it is in `conn` (taosAdapter shows it in its diagnostics). */
const CONNECTOR = "nodejs-ws-eon";

export interface TaosSqlOptions extends TaosSocketOptions {
	readonly url: string;
	readonly user?: string;
	readonly password?: string;
	readonly database?: string;
	readonly token?: string;
}

export interface TaosColumn {
	readonly name: string;
	readonly type: number;
}

export interface TaosQueryResult {
	readonly columns: readonly TaosColumn[];
	readonly rows: unknown[][];
}

/** Raise the server's refusal, with its code, when a reply carries one. */
export function checkReply(reply: WireObject, action: string): WireObject {
	const code = numberField(reply, "code") ?? 0;
	if (code !== 0) {
		throw new E_EON_SERVER_ERROR(
			stringField(reply, "message") ?? `'${action}' failed`,
			code,
		);
	}
	return reply;
}

function versionAtLeast(version: string, minimum: readonly number[]): boolean {
	const parts = version.split("-")[0]?.split(".").map(Number) ?? [];
	for (let i = 0; i < minimum.length; i++) {
		const have = parts[i] ?? 0;
		const want = minimum[i] ?? 0;
		if (Number.isNaN(have)) return false;
		if (have !== want) return have > want;
	}
	return true;
}

function binaryQueryFrame(reqId: bigint, sql: string): ArrayBuffer {
	const text = new TextEncoder().encode(sql);
	const frame = new Uint8Array(30 + text.length);
	const view = new DataView(frame.buffer);
	view.setBigUint64(0, reqId, true);
	view.setBigInt64(8, 0n, true);
	view.setBigInt64(16, BINARY_QUERY, true);
	view.setInt16(24, BINARY_VERSION, true);
	view.setInt32(26, text.length, true);
	frame.set(text, 30);
	return frame.buffer;
}

function fetchFrame(reqId: bigint, resultId: bigint): ArrayBuffer {
	const view = new DataView(new ArrayBuffer(26));
	view.setBigUint64(0, reqId, true);
	view.setBigInt64(8, resultId, true);
	view.setBigInt64(16, FETCH_RAW_BLOCK, true);
	view.setInt16(24, BINARY_VERSION, true);
	return view.buffer;
}

/** A binary reply's head: its code, and where its payload starts. */
export interface BinaryReply {
	readonly code: number;
	readonly message?: string;
	/** For a fetch: whether the result has no more blocks. */
	readonly finished: boolean;
	readonly block?: DataView;
}

/**
 * Read the common head of a binary reply:
 * `uint64 · uint64 action · uint16 version · uint64 timing · uint64 req_id ·
 * uint32 code`, then either `uint32 length · message` or
 * `uint64 result id · uint8 finished · uint32 block length · block`.
 */
export function readBinaryReply(bytes: ArrayBuffer): BinaryReply {
	const view = new DataView(bytes);
	const need = (end: number, what: string): void => {
		if (end > bytes.byteLength) {
			throw decodeError(`binary reply truncated reading ${what}`);
		}
	};
	need(38, "its code");
	const code = view.getUint32(34, true);
	if (code !== 0) {
		need(42, "the error length");
		const length = view.getUint32(38, true);
		need(42 + length, "the error message");
		const message = new TextDecoder().decode(new Uint8Array(bytes, 42, length));
		return { code, message, finished: true };
	}
	// A TMQ `fetch_raw_data` reply (action 8) has a uint16 meta type where a
	// query fetch has its finished flag.
	need(16, "its action");
	const rawData = view.getBigUint64(8, true) === FETCH_RAW_DATA_REPLY;
	need(51, "the finished flag");
	if (!rawData && view.getUint8(50) === 1) return { code, finished: true };
	const lengthAt = rawData ? 52 : 51;
	need(lengthAt + 4, "the block length");
	const length = view.getUint32(lengthAt, true);
	need(lengthAt + 4 + length, "the block");
	return {
		code,
		finished: false,
		block: length > 0 ? new DataView(bytes, lengthAt + 4, length) : undefined,
	};
}

function columnsOf(reply: WireObject): TaosColumn[] {
	const names = arrayField(reply, "fields_names") ?? [];
	const types = arrayField(reply, "fields_types") ?? [];
	const count = numberField(reply, "fields_count") ?? names.length;
	if (names.length !== count || types.length !== count) {
		throw decodeError(
			`the result announces ${count} column(s) but ${names.length} name(s) and ${types.length} type(s)`,
		);
	}
	return names.map((name, i) => {
		const type = types[i];
		if (typeof name !== "string" || typeof type !== "number") {
			throw decodeError(`column ${i} has no name or type`);
		}
		return { name, type };
	});
}

function fieldsOf(reply: WireObject): Stmt2Field[] {
	return (arrayField(reply, "fields") ?? []).map((entry, i) => {
		const field = asWireObject(entry);
		const type =
			field === undefined ? undefined : numberField(field, "field_type");
		const bindType =
			field === undefined ? undefined : numberField(field, "bind_type");
		if (field === undefined || type === undefined || bindType === undefined) {
			throw decodeError(`stmt2_prepare field ${i} has no type`);
		}
		return {
			name: stringField(field, "name") ?? `#${i}`,
			type,
			precision: numberField(field, "precision") ?? 0,
			scale: numberField(field, "scale") ?? 0,
			bindType,
		};
	});
}

export class TaosSql {
	readonly #socket: TaosSocket;
	readonly #version: string;

	private constructor(socket: TaosSocket, version: string) {
		this.#socket = socket;
		this.#version = version;
	}

	/** Open the socket and authenticate (`conn`); the server's version is read once. */
	static async connect(options: TaosSqlOptions): Promise<TaosSql> {
		const target = resolveTarget(options.url, "sql", { token: options.token });
		const socket = await TaosSocket.open(target.url, options);
		try {
			const conn: WireObject = {
				user: options.user ?? target.user ?? "",
				password: options.password ?? target.password ?? "",
				connector: CONNECTOR,
			};
			const database = options.database ?? target.database;
			if (database !== undefined && database !== "") conn.db = database;
			if (target.bearerToken !== undefined)
				conn.bearer_token = target.bearerToken;
			checkReply(await socket.request("conn", conn), "conn");
			const version = checkReply(
				await socket.request("version", {}),
				"version",
			);
			return new TaosSql(socket, stringField(version, "version") ?? "");
		} catch (error) {
			socket.close();
			throw error;
		}
	}

	get serverVersion(): string {
		return this.#version;
	}

	/** Run a statement; a SELECT's result is released unread. */
	async exec(sql: string): Promise<{ affectedRows: number }> {
		const reply = await this.#binaryQuery(sql);
		if (booleanField(reply, "is_update") !== true) {
			this.#free(bigintField(reply, "id"));
		}
		return { affectedRows: numberField(reply, "affected_rows") ?? 0 };
	}

	/** Run a statement and read every block of its result. */
	async query(sql: string): Promise<TaosQueryResult> {
		const reply = await this.#binaryQuery(sql);
		if (booleanField(reply, "is_update") === true)
			return { columns: [], rows: [] };
		const resultId = bigintField(reply, "id");
		if (resultId === undefined) {
			throw decodeError("a query reply carries no result id");
		}
		try {
			const columns = columnsOf(reply);
			const rows: unknown[][] = [];
			for (;;) {
				const bytes = await this.#socket.sendBinary(
					"fetch_raw_block",
					(reqId) => fetchFrame(reqId, resultId),
					"binary",
				);
				const block = readBinaryReply(bytes);
				if (block.code !== 0) {
					throw new E_EON_SERVER_ERROR(
						block.message ?? "fetch failed",
						block.code,
					);
				}
				if (block.finished) break;
				if (block.block === undefined) continue;
				for (const row of decodeRawBlock(block.block, columns.length).rows) {
					rows.push(row);
				}
			}
			return { columns, rows };
		} finally {
			this.#free(resultId);
		}
	}

	/** Write schemaless lines. */
	async schemaless(
		lines: readonly string[],
		protocol: 1 | 2 | 3,
		precision: string,
		ttl: number,
	): Promise<void> {
		checkReply(
			await this.#socket.request("insert", {
				protocol,
				precision,
				data: lines.join("\n"),
				ttl,
			}),
			"insert",
		);
	}

	/**
	 * Bind every table through one prepared stmt2 statement and execute each
	 * bind. The statement is closed whatever happens. `stable` names the
	 * super-table written to; it is needed only when a column is a DECIMAL,
	 * whose scale the server's schema is read for.
	 */
	async stmt2(
		sql: string,
		tables: readonly Stmt2Table[],
		stable?: string,
	): Promise<number> {
		if (!versionAtLeast(this.#version, STMT2_MIN_VERSION)) {
			throw new E_EON_SERVER_VERSION([this.#version]);
		}
		const init = checkReply(
			await this.#socket.request("stmt2_init", {
				single_stb_insert: true,
				single_table_bind_once: true,
			}),
			"stmt2_init",
		);
		const stmtId = bigintField(init, "stmt_id");
		if (stmtId === undefined)
			throw decodeError("stmt2_init returned no stmt_id");
		try {
			const prepared = checkReply(
				await this.#socket.request("stmt2_prepare", {
					sql,
					stmt_id: stmtId,
					get_fields: true,
				}),
				"stmt2_prepare",
			);
			if (booleanField(prepared, "is_insert") !== true) {
				throw new E_EON_BIND(["the columnar path only runs INSERT statements"]);
			}
			const fields = fieldsOf(prepared);
			const decimals = fields.some(
				(f) => f.type === TaosType.DECIMAL || f.type === TaosType.DECIMAL64,
			)
				? await this.#decimalShapes(stable)
				: new Map<string, DecimalShape>();
			let affected = 0;
			for (const table of tables) {
				checkReply(
					await this.#socket.sendBinary(
						"stmt2_bind",
						(reqId) => encodeBind(reqId, stmtId, fields, table, decimals),
						"text",
					),
					"stmt2_bind",
				);
				const executed = checkReply(
					await this.#socket.request("stmt2_exec", { stmt_id: stmtId }),
					"stmt2_exec",
				);
				affected += numberField(executed, "affected") ?? 0;
			}
			return affected;
		} finally {
			await this.#socket
				.request("stmt2_close", { stmt_id: stmtId })
				.catch(() => undefined);
		}
	}

	/** Close the socket; anything pending is rejected. */
	close(): void {
		this.#socket.close();
	}

	/** Each DECIMAL column's precision and scale, from `DESCRIBE`. */
	async #decimalShapes(
		stable: string | undefined,
	): Promise<Map<string, DecimalShape>> {
		if (stable === undefined || stable === "" || stable.includes("`")) {
			throw new E_EON_BIND([
				"a DECIMAL column is bound but the super-table to read its scale from is unknown",
			]);
		}
		const described = await this.query(`DESCRIBE \`${stable}\``);
		const shapes = new Map<string, DecimalShape>();
		for (const row of described.rows) {
			const [name, type] = row;
			if (typeof name !== "string" || typeof type !== "string") continue;
			const match = /^DECIMAL\((\d+),\s*(\d+)\)$/i.exec(type.trim());
			if (match === null) continue;
			shapes.set(name, {
				precision: Number(match[1]),
				scale: Number(match[2]),
			});
		}
		return shapes;
	}

	async #binaryQuery(sql: string): Promise<WireObject> {
		return checkReply(
			await this.#socket.sendBinary(
				"binary_query",
				(reqId) => binaryQueryFrame(reqId, sql),
				"text",
			),
			"binary_query",
		);
	}

	#free(resultId: bigint | undefined): void {
		if (resultId === undefined || resultId === 0n) return;
		this.#socket.sendWithoutReply("free_result", { id: resultId });
	}
}
