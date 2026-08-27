/** `@c9up/eon/tmq` — data subscription, without the rest of the barrel. */
export {
	type EonConsumer,
	type EonConsumerConfig,
	EonConsumerError,
	type EonMessage,
	type EonOffsetReset,
	type EonTopicPartition,
} from "./EonConsumer.js";
export { connectWsConsumer } from "./websocket.js";
