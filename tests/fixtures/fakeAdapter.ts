/**
 * A scripted stand-in for taosAdapter: a WebSocket server on a free local port
 * whose replies the test decides, byte for byte.
 *
 * Node ships a WebSocket client but no server, so this speaks just enough of
 * RFC 6455 for one client: the handshake, masked client frames (text, binary,
 * close, ping) and unmasked server frames. It exists to drive eon's client
 * into the cases a real server will not produce on demand — a late reply, a
 * mismatched id, an oversized or malformed frame, a server that hangs up.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type Received =
	| { kind: "text"; text: string; message: Record<string, unknown> }
	| { kind: "binary"; bytes: Uint8Array };

export interface AdapterConnection {
	text(value: string): void;
	json(value: Record<string, unknown>): void;
	binary(bytes: Uint8Array): void;
	hangUp(): void;
}

export interface FakeAdapter {
	readonly url: string;
	readonly received: Received[];
	readonly paths: string[];
	close(): Promise<void>;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
	const length = payload.length;
	let head: Buffer;
	if (length < 126) {
		head = Buffer.from([0x80 | opcode, length]);
	} else if (length < 65536) {
		head = Buffer.alloc(4);
		head[0] = 0x80 | opcode;
		head[1] = 126;
		head.writeUInt16BE(length, 2);
	} else {
		head = Buffer.alloc(10);
		head[0] = 0x80 | opcode;
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([head, payload]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text replies may carry 64-bit ids: write `bigint` values as bare numbers. */
export function jsonWithBigInts(value: unknown): string {
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return `[${value.map(jsonWithBigInts).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.map(([k, v]) => `${JSON.stringify(k)}:${jsonWithBigInts(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export async function startFakeAdapter(
	onMessage: (message: Received, connection: AdapterConnection) => void,
): Promise<FakeAdapter> {
	const received: Received[] = [];
	const paths: string[] = [];
	const sockets = new Set<Duplex>();
	const server: Server = createServer((_req, res) => {
		res.writeHead(426).end();
	});

	server.on("upgrade", (req, socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
		paths.push(req.url ?? "");
		const key = req.headers["sec-websocket-key"];
		const accept = createHash("sha1")
			.update(`${typeof key === "string" ? key : ""}${GUID}`)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const connection: AdapterConnection = {
			text: (value) => socket.write(frame(1, Buffer.from(value, "utf8"))),
			json: (value) =>
				socket.write(frame(1, Buffer.from(jsonWithBigInts(value), "utf8"))),
			binary: (bytes) => socket.write(frame(2, bytes)),
			hangUp: () => socket.destroy(),
		};
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			for (;;) {
				if (buffered.length < 2) return;
				const opcode = (buffered[0] ?? 0) & 0x0f;
				let length = (buffered[1] ?? 0) & 0x7f;
				let at = 2;
				if (length === 126) {
					if (buffered.length < 4) return;
					length = buffered.readUInt16BE(2);
					at = 4;
				} else if (length === 127) {
					if (buffered.length < 10) return;
					length = Number(buffered.readBigUInt64BE(2));
					at = 10;
				}
				if (buffered.length < at + 4 + length) return;
				const mask = buffered.subarray(at, at + 4);
				const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + length));
				for (let i = 0; i < payload.length; i++) {
					payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
				}
				buffered = buffered.subarray(at + 4 + length);
				if (opcode === 8) {
					socket.end(frame(8, payload.subarray(0, 2)));
					return;
				}
				if (opcode === 9) {
					socket.write(frame(10, payload));
					continue;
				}
				let message: Received;
				if (opcode === 1) {
					const text = payload.toString("utf8");
					const parsed: unknown = JSON.parse(text);
					message = {
						kind: "text",
						text,
						message: isRecord(parsed) ? parsed : {},
					};
				} else {
					message = { kind: "binary", bytes: new Uint8Array(payload) };
				}
				received.push(message);
				onMessage(message, connection);
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address: AddressInfo | string | null = server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `ws://127.0.0.1:${port}`,
		received,
		paths,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

/** The request id of a received message, text or binary. */
export function reqIdOf(message: Received): bigint {
	if (message.kind === "text") {
		const args = message.message.args;
		const id = isRecord(args) ? args.req_id : undefined;
		if (typeof id === "number") return BigInt(id);
		const match = /"req_id":(\d+)/.exec(message.text);
		return BigInt(match?.[1] ?? "0");
	}
	return new DataView(
		message.bytes.buffer,
		message.bytes.byteOffset,
		message.bytes.byteLength,
	).getBigUint64(0, true);
}

/** The action of a received text message. */
export function actionOf(message: Received): string | undefined {
	if (message.kind !== "text") return undefined;
	const action = message.message.action;
	return typeof action === "string" ? action : undefined;
}

/**
 * A binary reply head: `uint64 · uint64 action · uint16 version ·
 * uint64 timing · uint64 req_id · uint32 code`, then the body.
 */
export function binaryReply(
	reqId: bigint,
	body: Uint8Array,
	options: { action?: bigint; code?: number } = {},
): Uint8Array {
	const bytes = new Uint8Array(38 + body.length);
	const view = new DataView(bytes.buffer);
	view.setBigUint64(8, options.action ?? 7n, true);
	view.setUint16(16, 1, true);
	view.setBigUint64(26, reqId, true);
	view.setUint32(34, options.code ?? 0, true);
	bytes.set(body, 38);
	return bytes;
}
