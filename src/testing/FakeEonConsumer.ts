/**
 * An in-memory {@link EonConsumer}, so a subscription handler can be tested
 * without a server.
 *
 * The fake models the two things that actually bite: `poll` drains a queue
 * rather than replaying it, and `commit` only acknowledges what was polled. A
 * fake that returns the same batch forever hides the bug where a handler never
 * advances.
 */
import type {
	EonConsumer,
	EonMessage,
	EonTopicPartition,
} from "../tmq/EonConsumer.js";
import { EonConsumerError } from "../tmq/EonConsumer.js";

export class FakeEonConsumer implements EonConsumer {
	#topics: string[] = [];
	#queue: EonMessage[] = [];
	#polled = 0;
	#committed = 0;
	#closed = false;

	/** Queue messages a later `poll()` will return, in order. */
	push(...messages: EonMessage[]): this {
		this.#queue.push(...messages);
		return this;
	}

	/** How many messages have been acknowledged. */
	get committedCount(): number {
		return this.#committed;
	}

	/** Whether `close()` has run. */
	get isClosed(): boolean {
		return this.#closed;
	}

	#ensureOpen(): void {
		if (this.#closed) throw new EonConsumerError("eon: consumer is closed");
	}

	async subscribe(topics: string[]): Promise<void> {
		this.#ensureOpen();
		if (topics.length === 0) {
			throw new EonConsumerError("eon: subscribe() needs at least one topic");
		}
		this.#topics = [...topics];
	}

	async subscription(): Promise<string[]> {
		this.#ensureOpen();
		return [...this.#topics];
	}

	async poll<T = Record<string, unknown>>(
		_timeoutMs: number,
	): Promise<EonMessage<T>[]> {
		this.#ensureOpen();
		// Drain, don't replay: a real poll never hands back the same rows twice.
		const batch = this.#queue.splice(0, this.#queue.length);
		this.#polled += batch.length;
		return batch as EonMessage<T>[];
	}

	async commit(): Promise<EonTopicPartition[]> {
		this.#ensureOpen();
		this.#committed = this.#polled;
		return this.#topics.map((topic) => ({ topic, vgroupId: 0 }));
	}

	async assignment(topics?: string[]): Promise<EonTopicPartition[]> {
		this.#ensureOpen();
		return (topics ?? this.#topics).map((topic) => ({ topic, vgroupId: 0 }));
	}

	async seek(partition: EonTopicPartition): Promise<void> {
		this.#ensureOpen();
		if (partition.offset === undefined) {
			throw new EonConsumerError("eon: seek() needs an offset");
		}
	}

	async unsubscribe(): Promise<void> {
		this.#ensureOpen();
		this.#topics = [];
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}
