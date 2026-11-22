/**
 * TDengine's TMQ over taosAdapter's `/rest/tmq` endpoint.
 *
 * JSON requests (`subscribe`, `poll`, `commit`, `assignment`, `seek`,
 * `unsubscribe`, `list_topics`); a poll that has data is followed by one
 * `fetch_raw_data`, whose binary reply holds the message's blocks with their
 * schema. The protocol is read from `@tdengine/websocket` 3.5.0's source.
 *
 * Auto-commit is driven here, on poll, as that connector did — but only when
 * it was asked for. That connector compared the option's STRING, so "false"
 * was truthy and it committed on a timer whatever the caller set.
 */

import { decodeRawBlock } from "./block.js";
import { decodeError, TaosWireError } from "./errors.js";
import {
	arrayField,
	asWireObject,
	bigintField,
	booleanField,
	numberField,
	stringField,
	type WireObject,
	type WireValue,
} from "./json.js";
import { TaosSocket, type TaosSocketOptions } from "./socket.js";
import { checkReply, readBinaryReply } from "./sql.js";
import { resolveTarget } from "./url.js";

/** A poll result whose message holds rows (others are metadata). */
const DATA_MESSAGE = 1;

export interface TaosConsumerOptions extends TaosSocketOptions {
	readonly url: string;
	readonly groupId: string;
	readonly clientId?: string;
	readonly user?: string;
	readonly password?: string;
	readonly token?: string;
	readonly offsetReset: string;
	readonly autoCommit: boolean;
	readonly autoCommitIntervalMs: number;
	readonly withTableName: boolean;
}

export interface TaosPartition {
	readonly topic: string;
	readonly vgroupId: number;
	readonly offset?: bigint;
	readonly begin?: bigint;
	readonly end?: bigint;
}

export interface TaosPolled {
	readonly topic: string;
	readonly columns: readonly string[];
	readonly rows: unknown[][];
}

/** Bounds-checked reads over a TMQ raw-data payload. */
class Cursor {
	readonly #view: DataView;
	at: number;

	constructor(view: DataView, at = 0) {
		this.#view = view;
		this.at = at;
	}

	need(bytes: number, what: string): void {
		if (bytes < 0 || this.at + bytes > this.#view.byteLength) {
			throw decodeError(`TMQ data truncated reading ${what}`);
		}
	}

	uint8(what: string): number {
		this.need(1, what);
		const value = this.#view.getUint8(this.at);
		this.at += 1;
		return value;
	}

	int8(what: string): number {
		this.need(1, what);
		const value = this.#view.getInt8(this.at);
		this.at += 1;
		return value;
	}

	uint32(what: string): number {
		this.need(4, what);
		const value = this.#view.getUint32(this.at, true);
		this.at += 4;
		return value;
	}

	/** An unsigned LEB128-style integer (7 bits a byte), at most 5 bytes. */
	varint(what: string): number {
		let value = 0;
		let multiplier = 1;
		for (let i = 0; i < 5; i++) {
			const byte = this.uint8(what);
			value += (byte & 0x7f) * multiplier;
			if ((byte & 0x80) === 0) return value;
			multiplier *= 128;
		}
		throw decodeError(`TMQ varint for ${what} is too long`);
	}

	/** A zigzag-encoded signed varint. */
	zigzag(what: string): number {
		const raw = this.varint(what);
		return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
	}

	view(length: number, what: string): DataView {
		this.need(length, what);
		const view = new DataView(
			this.#view.buffer,
			this.#view.byteOffset + this.at,
			length,
		);
		this.at += length;
		return view;
	}

	text(length: number, what: string): string {
		const view = this.view(length, what);
		return new TextDecoder().decode(view);
	}
}

/** Skip the raw-data head: a length-prefixed one (≥ 100) or two typed words. */
function skipHead(cursor: Cursor): void {
	const first = cursor.uint8("the head type");
	if (first >= 100) {
		const skip = cursor.uint32("the head length");
		cursor.need(skip, "the head");
		cursor.at += skip;
		return;
	}
	const width = (type: number): number => {
		if (type === 1) return 8;
		if (type === 2 || type === 3) return 16;
		throw decodeError(`TMQ head type ${type} is unknown`);
	};
	const skip1 = width(first);
	cursor.need(skip1, "the head");
	cursor.at += skip1;
	const second = cursor.uint8("the head type");
	const skip2 = width(second);
	cursor.need(skip2, "the head");
	cursor.at += skip2;
}

/**
 * Decode a `fetch_raw_data` payload: `uint32 blocks · uint8 with table name ·
 * uint8 with schema`, then per block `varint length · 17-byte head ·
 * uint8 precision · raw block`, followed by its schema
 * (`zigzag cols · varint version · cols x (int8 type · int8 flag ·
 * zigzag bytes · zigzag id · varint name length · name with NUL)`) and, when
 * asked for, `varint length · table name`.
 */
export function decodeTmqData(view: DataView): {
	columns: string[];
	rows: unknown[][];
} {
	const cursor = new Cursor(view);
	skipHead(cursor);
	const blocks = cursor.uint32("the block count");
	if (blocks === 0) return { columns: [], rows: [] };
	const withTableName = cursor.uint8("the table-name flag") === 1;
	const withSchema = cursor.uint8("the schema flag") === 1;
	if (!withSchema) {
		throw decodeError("TMQ data carries no schema; its rows cannot be named");
	}
	let columns: string[] | undefined;
	const rows: unknown[][] = [];
	for (let b = 0; b < blocks; b++) {
		const length = cursor.varint("a block length");
		if (length < 18)
			throw decodeError(`TMQ block of ${length} byte(s) is too short`);
		const block = cursor.view(length, "a block");
		const raw = new DataView(block.buffer, block.byteOffset + 18, length - 18);

		const count = cursor.zigzag("the column count");
		if (count < 0 || count > 4096) {
			throw decodeError(`TMQ schema announces ${count} column(s)`);
		}
		cursor.varint("the schema version");
		const names: string[] = [];
		for (let c = 0; c < count; c++) {
			cursor.int8("a column type");
			cursor.int8("a column flag");
			cursor.zigzag("a column width");
			cursor.zigzag("a column id");
			const nameLength = cursor.varint("a column name length");
			if (nameLength < 1)
				throw decodeError("a TMQ column name has no terminator");
			names.push(cursor.text(nameLength - 1, "a column name"));
			cursor.at += 1;
		}
		if (withTableName) {
			const nameLength = cursor.varint("the table name length");
			cursor.view(nameLength, "the table name");
		}
		if (columns === undefined) columns = names;
		else if (columns.join("\u0000") !== names.join("\u0000")) {
			throw decodeError("blocks of one TMQ message have different columns");
		}
		for (const row of decodeRawBlock(raw, names.length).rows) rows.push(row);
	}
	return { columns: columns ?? [], rows };
}

function partitionOf(entry: WireValue, topic: string): TaosPartition {
	const object = asWireObject(entry);
	const vgroupId =
		object === undefined ? undefined : numberField(object, "vgroup_id");
	if (object === undefined || vgroupId === undefined) {
		throw decodeError("an assignment entry has no vgroup_id");
	}
	return {
		topic,
		vgroupId,
		offset: bigintField(object, "offset"),
		begin: bigintField(object, "begin"),
		end: bigintField(object, "end"),
	};
}

export class TaosConsumer {
	readonly #socket: TaosSocket;
	readonly #options: TaosConsumerOptions;
	readonly #target: ReturnType<typeof resolveTarget>;
	#topics: string[] = [];
	#lastMessageId = 0n;
	#lastCommit: number | undefined;

	private constructor(
		socket: TaosSocket,
		options: TaosConsumerOptions,
		target: ReturnType<typeof resolveTarget>,
	) {
		this.#socket = socket;
		this.#options = options;
		this.#target = target;
	}

	static async open(options: TaosConsumerOptions): Promise<TaosConsumer> {
		const target = resolveTarget(options.url, "tmq", {
			token: options.token,
			tokenParam: "bearer_token",
		});
		const socket = await TaosSocket.open(target.url, options);
		return new TaosConsumer(socket, options, target);
	}

	async subscribe(topics: string[]): Promise<void> {
		const config: WireObject = {
			"msg.with.table.name": this.#options.withTableName ? "true" : "false",
		};
		const token = this.#options.token ?? this.#target.bearerToken;
		if (token !== undefined) config["td.connect.token"] = token;
		const args: WireObject = {
			user: this.#options.user ?? this.#target.user ?? null,
			password: this.#options.password ?? this.#target.password ?? null,
			group_id: this.#options.groupId,
			client_id: this.#options.clientId ?? null,
			topics,
			// The protocol's own spelling.
			offset_rest: this.#options.offsetReset,
			auto_commit: this.#options.autoCommit ? "true" : "false",
			auto_commit_interval_ms: String(this.#options.autoCommitIntervalMs),
			config,
			connector: "nodejs-ws-eon",
		};
		checkReply(await this.#socket.request("subscribe", args), "subscribe");
		this.#topics = [...topics];
	}

	async subscription(): Promise<string[]> {
		const reply = checkReply(
			await this.#socket.request("list_topics", {}),
			"list_topics",
		);
		return (arrayField(reply, "topics") ?? []).filter(
			(topic): topic is string => typeof topic === "string",
		);
	}

	async poll(timeoutMs: number): Promise<TaosPolled[]> {
		if (this.#options.autoCommit) await this.#autoCommit();
		const reply = checkReply(
			await this.#socket.request(
				"poll",
				{ blocking_time: timeoutMs, message_id: this.#lastMessageId },
				// The server holds the request for up to `timeoutMs`.
				{ timeoutMs: timeoutMs + (this.#options.timeoutMs ?? 60_000) },
			),
			"poll",
		);
		if (booleanField(reply, "have_message") !== true) return [];
		const messageId = bigintField(reply, "message_id");
		if (messageId === undefined)
			throw decodeError("a poll reply has no message_id");
		this.#lastMessageId = messageId;
		const topic = stringField(reply, "topic") ?? "";
		if (numberField(reply, "message_type") !== DATA_MESSAGE) return [];
		const bytes = await this.#socket.requestBinaryReply("fetch_raw_data", {
			message_id: messageId,
		});
		const head = readBinaryReply(bytes);
		if (head.code !== 0) {
			throw new TaosWireError(head.message ?? "fetch_raw_data failed", {
				code: head.code,
			});
		}
		if (head.block === undefined) return [{ topic, columns: [], rows: [] }];
		const data = decodeTmqData(head.block);
		return [{ topic, columns: data.columns, rows: data.rows }];
	}

	async commit(): Promise<TaosPartition[]> {
		await this.#commit();
		return this.assignment();
	}

	async assignment(topics?: string[]): Promise<TaosPartition[]> {
		const wanted =
			topics !== undefined && topics.length > 0 ? topics : this.#topics;
		const out: TaosPartition[] = [];
		for (const topic of wanted) {
			const reply = checkReply(
				await this.#socket.request("assignment", { topic }),
				"assignment",
			);
			for (const entry of arrayField(reply, "assignment") ?? []) {
				out.push(partitionOf(entry, topic));
			}
		}
		return out;
	}

	async seek(partition: {
		topic: string;
		vgroupId: number;
		offset: bigint;
	}): Promise<void> {
		checkReply(
			await this.#socket.request("seek", {
				vgroup_id: partition.vgroupId,
				topic: partition.topic,
				offset: partition.offset,
			}),
			"seek",
		);
	}

	async unsubscribe(): Promise<void> {
		checkReply(await this.#socket.request("unsubscribe", {}), "unsubscribe");
		this.#topics = [];
	}

	close(): void {
		this.#socket.close();
	}

	async #commit(): Promise<void> {
		checkReply(
			await this.#socket.request("commit", { message_id: 0 }),
			"commit",
		);
		this.#lastCommit = Date.now();
	}

	async #autoCommit(): Promise<void> {
		const now = Date.now();
		if (this.#lastCommit === undefined) {
			this.#lastCommit = now;
			return;
		}
		if (now - this.#lastCommit >= this.#options.autoCommitIntervalMs) {
			await this.#commit();
		}
	}
}
