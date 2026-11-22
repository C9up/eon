/**
 * eon's taosAdapter client against a scripted server: requests matched to
 * replies by id, and every way a server can misbehave ending in an
 * `E_EON_*` error — never a crash, never a request left waiting.
 */
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { TaosType } from "../src/connection/taos/block.js";
import { TaosSocket } from "../src/connection/taos/socket.js";
import { TaosSql } from "../src/connection/taos/sql.js";
import { decodeTmqData, TaosConsumer } from "../src/connection/taos/tmq.js";
import { connectWsConsumer } from "../src/tmq/websocket.js";
import {
	actionOf,
	binaryReply,
	type FakeAdapter,
	type Received,
	reqIdOf,
	startFakeAdapter,
} from "./fixtures/fakeAdapter.js";
import { rawBlock } from "./fixtures/rawBlock.js";

const adapters: FakeAdapter[] = [];

afterEach(async () => {
	for (const adapter of adapters.splice(0)) await adapter.close();
});

async function adapter(
	onMessage: Parameters<typeof startFakeAdapter>[0],
): Promise<FakeAdapter> {
	const started = await startFakeAdapter(onMessage);
	adapters.push(started);
	return started;
}

/** Answer a text request with `code: 0` and these fields. */
function ok(message: Received, fields: Record<string, unknown> = {}) {
	return {
		code: 0,
		message: "",
		action: actionOf(message),
		req_id: reqIdOf(message),
		...fields,
	};
}

describe("TaosSocket", () => {
	it("matches replies to requests by id, in whatever order they come", async () => {
		const pending: Received[] = [];
		const server = await adapter((message, connection) => {
			pending.push(message);
			if (pending.length === 2) {
				// Answer the second first.
				for (const m of [...pending].reverse()) {
					connection.json(ok(m, { echo: actionOf(m) }));
				}
			}
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);
		const [a, b] = await Promise.all([
			socket.request("first", {}),
			socket.request("second", {}),
		]);

		expect(a.echo).toBe("first");
		expect(b.echo).toBe("second");
		socket.close();
	});

	it("drops a reply nobody waits for and still resolves the real one", async () => {
		const server = await adapter((message, connection) => {
			connection.json({ code: 0, req_id: 999_999, action: "stray" });
			connection.json(ok(message, { real: true }));
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);

		expect((await socket.request("version", {})).real).toBe(true);
		socket.close();
	});

	it("rejects a request that gets no reply within its deadline", async () => {
		const server = await adapter(() => {});
		const socket = await TaosSocket.open(`${server.url}/ws`, { timeoutMs: 50 });

		await expect(socket.request("version", {})).rejects.toThrow(
			/E_EON_TIMEOUT.*version/,
		);
		socket.close();
	});

	it("rejects every pending request when the server hangs up", async () => {
		const server = await adapter((message, connection) => {
			if (actionOf(message) === "second") connection.hangUp();
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);
		const first = socket.request("first", {});
		const second = socket.request("second", {});

		await expect(first).rejects.toThrow(/E_EON_CLOSED/);
		await expect(second).rejects.toThrow(/E_EON_CLOSED/);
		await expect(socket.request("third", {})).rejects.toThrow(/E_EON_CLOSED/);
	});

	it("closes on a frame over the size limit and fails what is pending", async () => {
		const server = await adapter((message, connection) => {
			connection.json(ok(message, { padding: "x".repeat(4096) }));
		});
		const socket = await TaosSocket.open(`${server.url}/ws`, {
			maxMessageBytes: 1024,
		});

		await expect(socket.request("version", {})).rejects.toThrow(
			/E_EON_DECODE.*exceeds the limit/,
		);
		expect(socket.closed).toBe(true);
	});

	it("closes on a text frame that is not a JSON object", async () => {
		const server = await adapter((_message, connection) => {
			connection.text("not json");
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);

		await expect(socket.request("version", {})).rejects.toThrow(
			/E_EON_DECODE.*not a JSON object/,
		);
	});

	it("closes on a binary frame too short to carry a request id", async () => {
		const server = await adapter((_message, connection) => {
			connection.binary(new Uint8Array(10));
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);

		await expect(socket.request("version", {})).rejects.toThrow(
			/E_EON_DECODE.*no request id/,
		);
	});

	it("fails a request answered with the wrong kind of frame", async () => {
		const server = await adapter((message, connection) => {
			connection.binary(binaryReply(reqIdOf(message), new Uint8Array(0)));
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);

		await expect(socket.request("version", {})).rejects.toThrow(
			/E_EON_DECODE.*expected a text reply/,
		);
		socket.close();
	});

	it("keeps an integer past 2^53 exact, in and out", async () => {
		const server = await adapter((message, connection) => {
			connection.json(ok(message, { offset: 9007199254740993n }));
		});
		const socket = await TaosSocket.open(`${server.url}/ws`);
		const reply = await socket.request("seek", {
			offset: 18446744073709551615n,
		});

		expect(reply.offset).toBe(9007199254740993n);
		const sent = server.received[0];
		expect(sent?.kind === "text" ? sent.text : "").toContain(
			'"offset":18446744073709551615',
		);
		socket.close();
	});

	it("rejects a handshake the server never completes", async () => {
		const held = new Set<Socket>();
		const silent = createServer((socket) => {
			held.add(socket);
		});
		await new Promise<void>((resolve) =>
			silent.listen(0, "127.0.0.1", resolve),
		);
		const address = silent.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		await expect(
			TaosSocket.open(`ws://127.0.0.1:${port}/ws`, { timeoutMs: 100 }),
		).rejects.toThrow(/E_EON_CONNECT.*100ms/);
		for (const socket of held) socket.destroy();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
	});
});

/** A fetch reply body: `uint64 result id · uint8 finished · uint32 length · block`. */
function fetchBody(block: Uint8Array | undefined): Uint8Array {
	const body = new Uint8Array(17 + (block?.length ?? 0));
	const view = new DataView(body.buffer);
	view.setBigUint64(4, 42n, true);
	view.setUint8(12, block === undefined ? 1 : 0);
	view.setUint32(13, block?.length ?? 0, true);
	if (block !== undefined) body.set(block, 17);
	return body;
}

/** A scripted SQL endpoint: conn, version, and one query (result 42) returning `block`. */
function sqlServer(
	block: Uint8Array,
	columns: { names: string[]; types: number[] },
) {
	let fetches = 0;
	return adapter((message, connection) => {
		if (message.kind === "text") {
			const action = actionOf(message);
			if (action === "conn") connection.json(ok(message));
			else if (action === "version") {
				connection.json(ok(message, { version: "3.3.6.13" }));
			}
			return;
		}
		const view = new DataView(message.bytes.buffer, message.bytes.byteOffset);
		const reqId = reqIdOf(message);
		if (view.getBigInt64(16, true) === 6n) {
			connection.json({
				code: 0,
				action: "binary_query",
				req_id: reqId,
				id: 42,
				is_update: false,
				fields_count: columns.names.length,
				fields_names: columns.names,
				fields_types: columns.types,
				fields_lengths: columns.types.map(() => 8),
			});
			return;
		}
		// fetch_raw_block of result 42: the block once, then finished.
		fetches += 1;
		connection.binary(
			binaryReply(reqId, fetchBody(fetches === 1 ? block : undefined)),
		);
	});
}

describe("TaosSql", () => {
	it("authenticates on /ws and sends the database only when set", async () => {
		const server = await sqlServer(new Uint8Array(0), { names: [], types: [] });
		const sql = await TaosSql.connect({
			url: `${server.url}/?token=t0k`,
			user: "root",
			password: "taosdata",
		});

		expect(server.paths[0]).toBe("/ws?token=t0k");
		const conn = server.received[0];
		expect(conn?.kind === "text" ? conn.message.args : undefined).toEqual({
			user: "root",
			password: "taosdata",
			connector: "nodejs-ws-eon",
			req_id: expect.any(Number),
		});
		expect(sql.serverVersion).toBe("3.3.6.13");
		sql.close();
	});

	it("queries, fetches every block, decodes it and frees the result", async () => {
		const block = rawBlock([
			{ type: TaosType.TIMESTAMP, values: [1n, 2n] },
			{ type: TaosType.VARCHAR, values: ["a", null] },
		]);
		const server = await sqlServer(block, {
			names: ["ts", "v"],
			types: [TaosType.TIMESTAMP, TaosType.VARCHAR],
		});
		const sql = await TaosSql.connect({
			url: server.url,
			user: "u",
			password: "p",
		});
		const result = await sql.query("SELECT ts, v FROM t");

		expect(result.columns.map((c) => c.name)).toEqual(["ts", "v"]);
		expect(result.rows).toEqual([
			[1n, "a"],
			[2n, null],
		]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const free = server.received.find((m) => actionOf(m) === "free_result");
		expect(free?.kind === "text" ? free.message.args : undefined).toMatchObject(
			{
				id: 42,
			},
		);
		sql.close();
	});

	it("carries the server's code when it refuses a statement", async () => {
		const server = await adapter((message, connection) => {
			if (message.kind === "text") {
				connection.json(ok(message, { version: "3.3.6.13" }));
				return;
			}
			connection.json({
				code: 9731,
				message: "Table does not exist",
				action: "binary_query",
				req_id: reqIdOf(message),
			});
		});
		const sql = await TaosSql.connect({
			url: server.url,
			user: "u",
			password: "p",
		});

		await expect(sql.exec("SELECT * FROM missing")).rejects.toMatchObject({
			code: 9731,
			message: "Table does not exist",
		});
		sql.close();
	});

	it("refuses stmt2 on a server older than 3.3.6.0", async () => {
		const server = await adapter((message, connection) => {
			connection.json(ok(message, { version: "3.3.5.2" }));
		});
		const sql = await TaosSql.connect({
			url: server.url,
			user: "u",
			password: "p",
		});

		await expect(sql.stmt2("INSERT INTO ? VALUES (?)", [])).rejects.toThrow(
			/E_EON_SERVER_VERSION/,
		);
		sql.close();
	});
});

/** One TMQ data payload: a v1 head, one block, its schema, a table name. */
function tmqPayload(names: string[], block: Uint8Array): Uint8Array {
	const parts: number[] = [];
	const varint = (n: number) => {
		let value = n;
		do {
			let byte = value & 0x7f;
			value = Math.floor(value / 128);
			if (value > 0) byte |= 0x80;
			parts.push(byte);
		} while (value > 0);
	};
	const zigzag = (n: number) => varint(n >= 0 ? n * 2 : -n * 2 - 1);
	// Head: type 1 (8 bytes), type 1 (8 bytes).
	parts.push(1, ...new Array(8).fill(0), 1, ...new Array(8).fill(0));
	parts.push(1, 0, 0, 0); // one block
	parts.push(1, 1); // with table name, with schema
	varint(18 + block.length);
	parts.push(...new Array(17).fill(0), 0, ...block);
	zigzag(names.length);
	varint(1);
	for (const name of names) {
		parts.push(TaosType.INT, 0);
		zigzag(4);
		zigzag(1);
		const bytes = [...new TextEncoder().encode(name), 0];
		varint(bytes.length);
		parts.push(...bytes);
	}
	const table = [...new TextEncoder().encode("d0")];
	varint(table.length);
	parts.push(...table);
	return new Uint8Array(parts);
}

describe("TMQ", () => {
	it("decodes a raw-data payload into named rows", () => {
		const block = rawBlock([
			{ type: TaosType.INT, values: [1, null] },
			{ type: TaosType.INT, values: [10, 20] },
		]);
		const payload = tmqPayload(["a", "b"], block);

		expect(decodeTmqData(new DataView(payload.buffer))).toEqual({
			columns: ["a", "b"],
			rows: [
				[1, 10],
				[null, 20],
			],
		});
	});

	it("refuses a truncated raw-data payload", () => {
		const payload = tmqPayload(
			["a"],
			rawBlock([{ type: TaosType.INT, values: [1] }]),
		);

		expect(() =>
			decodeTmqData(new DataView(payload.buffer, 0, payload.length - 3)),
		).toThrow(/E_EON_DECODE/);
	});

	it("subscribes on /rest/tmq with auto-commit off, and never commits behind the caller", async () => {
		const server = await adapter((message, connection) => {
			connection.json(ok(message, { have_message: false }));
		});
		const consumer = await connectWsConsumer({
			url: server.url,
			groupId: "g1",
			user: "root",
			password: "taosdata",
			autoCommitIntervalMs: 0,
		});
		await consumer.subscribe(["t1"]);
		await consumer.poll(10);
		await consumer.poll(10);

		expect(server.paths[0]).toBe("/rest/tmq");
		const subscribe = server.received.find((m) => actionOf(m) === "subscribe");
		expect(
			subscribe?.kind === "text" ? subscribe.message.args : undefined,
		).toMatchObject({
			group_id: "g1",
			topics: ["t1"],
			auto_commit: "false",
			offset_rest: "latest",
			config: { "msg.with.table.name": "true" },
		});
		expect(server.received.some((m) => actionOf(m) === "commit")).toBe(false);
		await consumer.close();
	});

	it("commits on poll once the interval has passed when auto-commit is on", async () => {
		const server = await adapter((message, connection) => {
			connection.json(ok(message, { have_message: false, assignment: [] }));
		});
		const consumer = await TaosConsumer.open({
			url: server.url,
			groupId: "g",
			offsetReset: "earliest",
			autoCommit: true,
			autoCommitIntervalMs: 0,
			withTableName: true,
		});
		await consumer.poll(10);
		await consumer.poll(10);

		expect(
			server.received.filter((m) => actionOf(m) === "commit"),
		).toHaveLength(1);
		consumer.close();
	});

	it("fetches and names the rows of a data message", async () => {
		const block = rawBlock([{ type: TaosType.INT, values: [7] }]);
		const payload = tmqPayload(["v"], block);
		const server = await adapter((message, connection) => {
			const action = actionOf(message);
			if (action === "poll") {
				connection.json(
					ok(message, {
						have_message: true,
						topic: "t1",
						message_id: 5,
						message_type: 1,
					}),
				);
			} else if (action === "fetch_raw_data") {
				const body = new Uint8Array(18 + payload.length);
				const view = new DataView(body.buffer);
				view.setBigUint64(4, 5n, true);
				view.setUint32(14, payload.length, true);
				body.set(payload, 18);
				connection.binary(binaryReply(reqIdOf(message), body, { action: 8n }));
			} else {
				connection.json(ok(message));
			}
		});
		const consumer = await connectWsConsumer({ url: server.url, groupId: "g" });

		expect(await consumer.poll(10)).toEqual([
			{ topic: "t1", rows: [{ v: 7 }] },
		]);
		const fetch = server.received.find((m) => actionOf(m) === "fetch_raw_data");
		expect(
			fetch?.kind === "text" ? fetch.message.args : undefined,
		).toMatchObject({
			message_id: 5,
		});
		await consumer.close();
	});
});
