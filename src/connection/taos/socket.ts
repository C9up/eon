/**
 * One WebSocket to taosAdapter, with requests matched to replies by id.
 *
 * Built on Node's own `WebSocket` (Node 24+), so eon installs no socket
 * library. taosAdapter answers in two shapes: a JSON text frame carrying the
 * request's `req_id`, or a binary frame whose bytes 26–33 hold it. Every
 * request waits for exactly one reply of the shape its action produces; a reply
 * of the other shape, or one that does not decode, fails that request rather
 * than being guessed at.
 *
 * What a misbehaving server can and cannot do here:
 * - a reply for an id nobody waits for (a late answer to a timed-out request)
 *   is dropped;
 * - a frame larger than `maxMessageBytes`, a binary frame too short to carry an
 *   id, or a text frame that is not a JSON object closes the socket and fails
 *   every pending request — the stream can no longer be trusted;
 * - every request has a deadline, and closing the socket (either side) rejects
 *   whatever is still pending. Nothing waits forever.
 *
 * The size check runs on a received frame: Node's `WebSocket` has no option to
 * refuse a large frame before buffering it (it stops at 2^31 bytes).
 */

import type { Exception } from "@c9up/flare";
import {
	E_EON_CLOSED,
	E_EON_CONNECT,
	E_EON_DECODE,
	E_EON_TIMEOUT,
} from "../../errors.js";
import {
	bigintField,
	encodeWire,
	parseWireObject,
	type WireObject,
} from "./json.js";

/** Default largest frame accepted: a raw block holds at most a few MiB in practice. */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/** Default per-request deadline, the one the previous connector used. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Where a binary reply carries the id of the request it answers. */
const BINARY_REQ_ID_OFFSET = 26;

export interface TaosSocketOptions {
	/** Handshake and per-request deadline in ms. */
	timeoutMs?: number;
	/** Largest frame accepted, in bytes. */
	maxMessageBytes?: number;
}

type Reply =
	| { kind: "text"; message: WireObject }
	| { kind: "binary"; bytes: ArrayBuffer };

interface Pending {
	readonly expects: Reply["kind"];
	readonly action: string;
	readonly resolve: (reply: Reply) => void;
	readonly reject: (error: Exception) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

let lastReqId = 0n;

/** A request id unique within this process (taosAdapter only needs it per socket). */
export function nextReqId(): bigint {
	lastReqId += 1n;
	return lastReqId;
}

function closedError(detail: string): Exception {
	return new E_EON_CLOSED([detail]);
}

export class TaosSocket {
	readonly #socket: WebSocket;
	readonly #timeoutMs: number;
	readonly #maxMessageBytes: number;
	readonly #pending = new Map<bigint, Pending>();
	#closed = false;

	private constructor(socket: WebSocket, options: TaosSocketOptions) {
		this.#socket = socket;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#maxMessageBytes =
			options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		socket.addEventListener("message", (event) => this.#onMessage(event.data));
		socket.addEventListener("close", (event) => {
			this.#shutDown(
				closedError(
					`the server closed the connection (${event.code}${event.reason ? ` ${event.reason}` : ""})`,
				),
			);
		});
		socket.addEventListener("error", () => {
			this.#shutDown(closedError("the connection failed"));
		});
	}

	/**
	 * Open the socket, or reject — on a refused connection, a failed handshake
	 * or no handshake within the deadline. The URL is never put in the error:
	 * it may carry credentials.
	 */
	static open(
		url: string,
		options: TaosSocketOptions = {},
	): Promise<TaosSocket> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			let socket: WebSocket;
			try {
				socket = new WebSocket(url);
			} catch (cause) {
				reject(new E_EON_CONNECT(["invalid WebSocket URL"], { cause }));
				return;
			}
			socket.binaryType = "arraybuffer";
			let settled = false;
			const settle = (outcome: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onFailure);
				socket.removeEventListener("close", onFailure);
				outcome();
			};
			const onOpen = (): void => {
				settle(() => resolve(new TaosSocket(socket, options)));
			};
			const onFailure = (): void => {
				settle(() => reject(new E_EON_CONNECT(["WebSocket handshake failed"])));
			};
			const timer = setTimeout(() => {
				settle(() => {
					socket.close();
					reject(
						new E_EON_CONNECT([
							`WebSocket handshake did not complete within ${timeoutMs}ms`,
						]),
					);
				});
			}, timeoutMs);
			socket.addEventListener("open", onOpen);
			socket.addEventListener("error", onFailure);
			socket.addEventListener("close", onFailure);
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Send a JSON request and wait for its JSON reply. `args.req_id` is set here. */
	async request(
		action: string,
		args: WireObject,
		options: { timeoutMs?: number } = {},
	): Promise<WireObject> {
		const reqId = nextReqId();
		const reply = await this.#send(
			reqId,
			action,
			encodeWire({ action, args: { ...args, req_id: reqId } }),
			"text",
			options.timeoutMs,
		);
		return textOf(reply);
	}

	/** Send a JSON request whose reply is a binary frame (`fetch_raw_data`). */
	async requestBinaryReply(
		action: string,
		args: WireObject,
	): Promise<ArrayBuffer> {
		const reqId = nextReqId();
		const reply = await this.#send(
			reqId,
			action,
			encodeWire({ action, args: { ...args, req_id: reqId } }),
			"binary",
		);
		return bytesOf(reply);
	}

	/** Send a binary request (its id already written by `encode`) and wait for the reply. */
	async sendBinary(
		action: string,
		encode: (reqId: bigint) => ArrayBuffer,
		expects: "text",
	): Promise<WireObject>;
	async sendBinary(
		action: string,
		encode: (reqId: bigint) => ArrayBuffer,
		expects: "binary",
	): Promise<ArrayBuffer>;
	async sendBinary(
		action: string,
		encode: (reqId: bigint) => ArrayBuffer,
		expects: Reply["kind"],
	): Promise<WireObject | ArrayBuffer> {
		const reqId = nextReqId();
		const reply = await this.#send(reqId, action, encode(reqId), expects);
		return reply.kind === "text" ? reply.message : reply.bytes;
	}

	/** Send a message taosAdapter does not answer (`free_result`). */
	sendWithoutReply(action: string, args: WireObject): void {
		if (this.#closed) return;
		try {
			this.#socket.send(
				encodeWire({ action, args: { ...args, req_id: nextReqId() } }),
			);
		} catch {
			// The socket is going down; its close handler fails what is pending.
		}
	}

	/** Close the socket and fail anything still waiting. Safe to call twice. */
	close(): void {
		if (this.#closed) return;
		this.#shutDown(closedError("the connection was closed"));
		this.#socket.close(1000);
	}

	#send(
		reqId: bigint,
		action: string,
		payload: string | ArrayBuffer,
		expects: Reply["kind"],
		timeoutMs = this.#timeoutMs,
	): Promise<Reply> {
		if (this.#closed) {
			return Promise.reject(closedError(`cannot send '${action}'`));
		}
		return new Promise<Reply>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#pending.delete(reqId)) {
					reject(
						new E_EON_TIMEOUT([
							`'${action}' got no reply within ${timeoutMs}ms`,
						]),
					);
				}
			}, timeoutMs);
			this.#pending.set(reqId, { expects, action, resolve, reject, timer });
			try {
				this.#socket.send(payload);
			} catch (cause) {
				clearTimeout(timer);
				this.#pending.delete(reqId);
				reject(closedError(`cannot send '${action}': ${String(cause)}`));
			}
		});
	}

	#onMessage(data: unknown): void {
		if (this.#closed) return;
		if (typeof data === "string") {
			if (data.length > this.#maxMessageBytes) {
				this.#fail(
					`a text frame of ${data.length} characters exceeds the limit`,
				);
				return;
			}
			const message = parseWireObject(data);
			if (message === undefined) {
				this.#fail("a text frame is not a JSON object");
				return;
			}
			const reqId = bigintField(message, "req_id");
			if (reqId !== undefined) this.#settle(reqId, { kind: "text", message });
			return;
		}
		if (data instanceof ArrayBuffer) {
			if (data.byteLength > this.#maxMessageBytes) {
				this.#fail(
					`a binary frame of ${data.byteLength} bytes exceeds the limit`,
				);
				return;
			}
			if (data.byteLength < BINARY_REQ_ID_OFFSET + 8) {
				this.#fail(
					`a binary frame of ${data.byteLength} bytes carries no request id`,
				);
				return;
			}
			const reqId = new DataView(data).getBigUint64(BINARY_REQ_ID_OFFSET, true);
			this.#settle(reqId, { kind: "binary", bytes: data });
			return;
		}
		this.#fail("a frame of an unknown type arrived");
	}

	#settle(reqId: bigint, reply: Reply): void {
		const pending = this.#pending.get(reqId);
		// A reply nobody waits for answers a request that already timed out.
		if (pending === undefined) return;
		this.#pending.delete(reqId);
		clearTimeout(pending.timer);
		if (pending.expects !== reply.kind) {
			pending.reject(
				new E_EON_DECODE([
					`'${pending.action}' expected a ${pending.expects} reply, got a ${reply.kind} frame`,
				]),
			);
			return;
		}
		pending.resolve(reply);
	}

	#fail(detail: string): void {
		this.#shutDown(new E_EON_DECODE([`${detail}; connection closed`]));
		// A client may only send 1000 or 3000–4999; 4002 says "protocol error".
		this.#socket.close(4002, "protocol error");
	}

	#shutDown(error: Exception): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function textOf(reply: Reply): WireObject {
	if (reply.kind !== "text") {
		throw new E_EON_DECODE(["expected a JSON reply"]);
	}
	return reply.message;
}

function bytesOf(reply: Reply): ArrayBuffer {
	if (reply.kind !== "binary") {
		throw new E_EON_DECODE(["expected a binary reply"]);
	}
	return reply.bytes;
}
