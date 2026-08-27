/**
 * The TMQ consumer seam and its fake.
 *
 * Two defaults get the most attention because they are the ones a caller never
 * sets and never sees: auto-commit is OFF, and an empty `subscribe` is refused.
 * Both are cases where the driver's behaviour loses data quietly.
 */
import { describe, expect, it } from "vitest";
import { FakeEonConsumer } from "../src/testing/FakeEonConsumer.js";
import { EonConsumerError } from "../src/tmq/EonConsumer.js";

describe("FakeEonConsumer", () => {
	it("drains a poll instead of replaying it", async () => {
		const consumer = new FakeEonConsumer();
		await consumer.subscribe(["meters"]);
		consumer.push({ topic: "meters", rows: [{ v: 1 }, { v: 2 }] });

		expect(await consumer.poll(10)).toEqual([
			{ topic: "meters", rows: [{ v: 1 }, { v: 2 }] },
		]);
		// A fake that replays hides the bug where a handler never advances.
		expect(await consumer.poll(10)).toEqual([]);
	});

	it("commits only what was polled", async () => {
		const consumer = new FakeEonConsumer();
		await consumer.subscribe(["meters"]);
		consumer.push({ topic: "meters", rows: [{ v: 1 }] });

		await consumer.commit();
		expect(consumer.committedCount).toBe(0);

		await consumer.poll(10);
		await consumer.commit();
		expect(consumer.committedCount).toBe(1);
	});

	it("refuses an empty subscribe rather than delivering nothing forever", async () => {
		const consumer = new FakeEonConsumer();
		await expect(consumer.subscribe([])).rejects.toThrow(
			/needs at least one topic/,
		);
	});

	it("reports its subscription, and forgets it on unsubscribe", async () => {
		const consumer = new FakeEonConsumer();
		await consumer.subscribe(["a", "b"]);
		expect(await consumer.subscription()).toEqual(["a", "b"]);

		await consumer.unsubscribe();
		expect(await consumer.subscription()).toEqual([]);
	});

	it("close is idempotent, and every operation refuses afterwards", async () => {
		const consumer = new FakeEonConsumer();
		await consumer.subscribe(["meters"]);
		await consumer.close();
		await consumer.close(); // a `finally` that closes twice must not throw

		expect(consumer.isClosed).toBe(true);
		await expect(consumer.poll(10)).rejects.toThrow(EonConsumerError);
		await expect(consumer.commit()).rejects.toThrow(/consumer is closed/);
	});

	it("seek needs an offset", async () => {
		const consumer = new FakeEonConsumer();
		await consumer.subscribe(["meters"]);
		await expect(
			consumer.seek({ topic: "meters", vgroupId: 0 }),
		).rejects.toThrow(/needs an offset/);
		await expect(
			consumer.seek({ topic: "meters", vgroupId: 0, offset: 12n }),
		).resolves.toBeUndefined();
	});
});

describe("consumer defaults", () => {
	it("does not turn auto-commit on behind the caller's back", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../src/tmq/websocket.ts", import.meta.url), "utf8"),
		);

		// The driver defaults auto-commit ON. Acknowledging a message the handler
		// has not finished with loses it silently on a crash, so eon inverts it —
		// this pins the inversion rather than trusting the comment.
		expect(source).toContain('config.autoCommit === true ? "true" : "false"');
	});

	it("leaks no ws type through the seam", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(
				new URL("../src/tmq/EonConsumer.ts", import.meta.url),
				"utf8",
			),
		);
		// The contract must stay transport-neutral, so a native transport can
		// implement it later without any consumer changing.
		expect(source).not.toMatch(/@tdengine/);
	});
});
