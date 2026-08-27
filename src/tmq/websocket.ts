/**
 * WebSocket implementation of {@link EonConsumer}, over `@tdengine/websocket`'s
 * `WsConsumer` (ws-only via taosAdapter, like the SQL connection).
 *
 * Thin by design: the driver already speaks TMQ. What this adds is the seam
 * (no ws type leaks out), decoded rows instead of a `TaosResult`, one error
 * type, and two defaults chosen for safety rather than convenience — see
 * `autoCommit` and `offsetReset`.
 */
import {
	type TaosResult,
	TDWebSocketClientError,
	TMQConstants,
	WsConsumer,
} from "@tdengine/websocket";
import {
	type EonConsumer,
	type EonConsumerConfig,
	EonConsumerError,
	type EonMessage,
	type EonTopicPartition,
} from "./EonConsumer.js";

function wrapError(cause: unknown, message: string): EonConsumerError {
	if (cause instanceof TDWebSocketClientError) {
		return new EonConsumerError(`${message}: ${cause.message}`, {
			cause,
			code: cause.code,
		});
	}
	return new EonConsumerError(message, { cause });
}

/** Zip a poll result's column metadata with its rows. */
function decode<T>(result: TaosResult): T[] {
	const meta = result.getMeta() ?? [];
	const data = result.getData() ?? [];
	if (data.length > 0 && meta.length === 0) {
		// The same trap the query decoder guards: rows with no column metadata
		// would each decode to `{}` — silent data loss. Fail loud.
		throw new EonConsumerError(
			`[E_EON_DECODE] poll returned rows but no column metadata for topic '${result.getTopic()}'; cannot decode`,
		);
	}
	return data.map((row: unknown[]) => {
		const record: Record<string, unknown> = {};
		meta.forEach((column, index) => {
			record[column.name] = row[index];
		});
		return record as T;
	});
}

function toPartition(p: {
	topic: string;
	vgroup_id: number;
	offset?: bigint;
	begin?: bigint;
	end?: bigint;
}): EonTopicPartition {
	return {
		topic: p.topic,
		vgroupId: p.vgroup_id,
		offset: p.offset,
		begin: p.begin,
		end: p.end,
	};
}

/**
 * Open a consumer against a taosAdapter WebSocket endpoint.
 *
 * `autoCommit` defaults to FALSE, where the driver defaults it on. Auto-commit
 * acknowledges messages the handler may not have finished with, so a crash
 * drops them silently; a subscription that loses data without saying so is
 * worse than one that redelivers.
 */
export async function connectWsConsumer(
	config: EonConsumerConfig,
): Promise<EonConsumer> {
	const options = new Map<string, string>([
		[TMQConstants.WS_URL, config.url],
		[TMQConstants.GROUP_ID, config.groupId],
		[TMQConstants.AUTO_OFFSET_RESET, config.offsetReset ?? "latest"],
		[
			TMQConstants.ENABLE_AUTO_COMMIT,
			config.autoCommit === true ? "true" : "false",
		],
		[
			TMQConstants.MSG_WITH_TABLE_NAME,
			config.withTableName === false ? "false" : "true",
		],
	]);
	if (config.clientId) options.set(TMQConstants.CLIENT_ID, config.clientId);
	if (config.user) options.set(TMQConstants.CONNECT_USER, config.user);
	if (config.password) options.set(TMQConstants.CONNECT_PASS, config.password);
	if (config.token) options.set(TMQConstants.CONNECT_TOKEN, config.token);
	if (config.autoCommit === true && config.autoCommitIntervalMs !== undefined) {
		options.set(
			TMQConstants.AUTO_COMMIT_INTERVAL_MS,
			String(config.autoCommitIntervalMs),
		);
	}

	let consumer: WsConsumer;
	try {
		consumer = await WsConsumer.newConsumer(options);
	} catch (error) {
		throw wrapError(error, `eon: failed to open a consumer on '${config.url}'`);
	}

	let closed = false;
	function ensureOpen(): void {
		if (closed) {
			throw new EonConsumerError("eon: consumer is closed");
		}
	}

	return {
		async subscribe(topics: string[]): Promise<void> {
			ensureOpen();
			if (topics.length === 0) {
				// An empty subscribe is accepted by the server and then delivers
				// nothing forever — a silent no-op is the worst possible answer.
				throw new EonConsumerError("eon: subscribe() needs at least one topic");
			}
			try {
				await consumer.subscribe(topics);
			} catch (error) {
				throw wrapError(
					error,
					`eon: subscribe failed for [${topics.join(", ")}]`,
				);
			}
		},

		async subscription(): Promise<string[]> {
			ensureOpen();
			try {
				return await consumer.subscription();
			} catch (error) {
				throw wrapError(error, "eon: reading the subscription failed");
			}
		},

		async poll<T = Record<string, unknown>>(
			timeoutMs: number,
		): Promise<EonMessage<T>[]> {
			ensureOpen();
			let polled: Map<string, TaosResult>;
			try {
				polled = await consumer.poll(timeoutMs);
			} catch (error) {
				throw wrapError(error, "eon: poll failed");
			}
			const out: EonMessage<T>[] = [];
			for (const [topic, result] of polled) {
				out.push({ topic, rows: decode<T>(result) });
			}
			return out;
		},

		async commit(): Promise<EonTopicPartition[]> {
			ensureOpen();
			try {
				return (await consumer.commit()).map(toPartition);
			} catch (error) {
				throw wrapError(error, "eon: commit failed");
			}
		},

		async assignment(topics?: string[]): Promise<EonTopicPartition[]> {
			ensureOpen();
			try {
				return (await consumer.assignment(topics)).map(toPartition);
			} catch (error) {
				throw wrapError(error, "eon: reading the assignment failed");
			}
		},

		async seek(partition: EonTopicPartition): Promise<void> {
			ensureOpen();
			if (partition.offset === undefined) {
				throw new EonConsumerError("eon: seek() needs an offset");
			}
			try {
				await consumer.seek({
					topic: partition.topic,
					vgroup_id: partition.vgroupId,
					offset: partition.offset,
				} as Parameters<WsConsumer["seek"]>[0]);
			} catch (error) {
				throw wrapError(error, `eon: seek failed on '${partition.topic}'`);
			}
		},

		async unsubscribe(): Promise<void> {
			ensureOpen();
			try {
				await consumer.unsubscribe();
			} catch (error) {
				throw wrapError(error, "eon: unsubscribe failed");
			}
		},

		async close(): Promise<void> {
			// Idempotent: a `finally` that closes twice must not throw.
			if (closed) return;
			closed = true;
			try {
				await consumer.close();
			} catch (error) {
				throw wrapError(error, "eon: closing the consumer failed");
			}
		},
	};
}
