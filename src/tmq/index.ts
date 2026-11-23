/** `@c9up/eon/tmq` — data subscription, without the rest of the barrel. */

export * as errors from "../errors.js";
export type {
	EonConsumer,
	EonConsumerConfig,
	EonMessage,
	EonOffsetReset,
	EonTopicPartition,
} from "./EonConsumer.js";
export { connectWsConsumer } from "./websocket.js";
