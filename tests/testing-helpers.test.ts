import { describe, expect, it } from "vitest";
import {
	childTableName,
	Column,
	createChildTable,
	SuperTable,
	syncSuperTable,
	Tag,
	Timestamp,
} from "../src/index.js";
import { factory, FakeEonConnection } from "../src/testing/index.js";

@SuperTable("meters")
class MeterPoint {
	@Timestamp() declare ts: number;
	@Column({ type: "float" }) declare current: number;
	@Tag({ type: "int" }) declare groupid: number;
}

describe("FakeEonConnection — store + flat SELECT", () => {
	it("records exec statements and answers a flat SELECT", async () => {
		const conn = new FakeEonConnection();
		await conn.exec(
			"CREATE TABLE IF NOT EXISTS `t` (`ts` TIMESTAMP, `v` INT)",
		);
		await conn.exec("INSERT INTO `t` (`ts`, `v`) VALUES (1, 10), (2, 20)");
		expect(conn.statements).toHaveLength(2);
		expect(await conn.query("SELECT `ts`, `v` FROM `t`")).toEqual([
			{ ts: 1, v: 10 },
			{ ts: 2, v: 20 },
		]);
	});

	it("filters on a WHERE predicate and honours LIMIT", async () => {
		const conn = new FakeEonConnection();
		await conn.exec("CREATE TABLE `t` (`ts` TIMESTAMP, `v` INT)");
		await conn.exec("INSERT INTO `t` (`ts`, `v`) VALUES (1, 10), (2, 20), (3, 30)");
		expect(await conn.query("SELECT `v` FROM `t` WHERE `v` > 10")).toEqual([
			{ v: 20 },
			{ v: 30 },
		]);
		expect(await conn.query("SELECT `ts` FROM `t` LIMIT 1")).toEqual([
			{ ts: 1 },
		]);
	});

	it("throws E_EON_FAKE_UNSUPPORTED for windowed/aggregate SQL", async () => {
		const conn = new FakeEonConnection();
		await conn.exec("CREATE TABLE `t` (`ts` TIMESTAMP, `v` INT)");
		await expect(
			conn.query("SELECT avg(`v`) FROM `t` INTERVAL(1h)"),
		).rejects.toThrow(/E_EON_FAKE_UNSUPPORTED/);
		await expect(conn.query("SELECT count(*) FROM `t`")).rejects.toThrow(
			/E_EON_FAKE_UNSUPPORTED/,
		);
	});

	it("fails loud (not open) on a multi-predicate or unparseable WHERE", async () => {
		const conn = new FakeEonConnection();
		await conn.exec("CREATE TABLE `t` (`ts` TIMESTAMP, `v` INT)");
		await conn.exec("INSERT INTO `t` (`ts`, `v`) VALUES (1, 10), (2, 20)");
		// A conjunctive filter the flat store cannot evaluate must throw, never
		// silently drop the predicate and return every row.
		await expect(
			conn.query("SELECT `v` FROM `t` WHERE `v` > 5 AND `v` < 15"),
		).rejects.toThrow(/E_EON_FAKE_UNSUPPORTED/);
		// A non-backtick column is unparseable → unsupported, not all-rows.
		await expect(
			conn.query("SELECT `v` FROM `t` WHERE v = 10"),
		).rejects.toThrow(/E_EON_FAKE_UNSUPPORTED/);
	});

	it("ingestColumnar and schemaless are out of scope", async () => {
		const conn = new FakeEonConnection();
		await expect(
			conn.ingestColumnar({ sql: "", children: [] }),
		).rejects.toThrow(/E_EON_FAKE_UNSUPPORTED/);
		await expect(conn.schemaless(["m v=1"])).rejects.toThrow(
			/E_EON_FAKE_UNSUPPORTED/,
		);
	});

	it("reset clears statements and the store", async () => {
		const conn = new FakeEonConnection();
		await conn.exec("CREATE TABLE `t` (`ts` TIMESTAMP, `v` INT)");
		await conn.exec("INSERT INTO `t` (`ts`, `v`) VALUES (1, 10)");
		conn.reset();
		expect(conn.statements).toEqual([]);
		expect(conn.rows("t")).toEqual([]);
	});

	it("has transport 'fake'", () => {
		expect(new FakeEonConnection().transport).toBe("fake");
	});
});

describe("FakeEonConnection — fidelity against the real DDL compiler", () => {
	it("captures the exact compiled CREATE STABLE from syncSuperTable", async () => {
		const conn = new FakeEonConnection();
		await syncSuperTable(conn, MeterPoint);
		expect(conn.statements).toEqual([
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)",
		]);
	});

	it("captures the exact compiled child-table CREATE", async () => {
		const conn = new FakeEonConnection();
		await createChildTable(conn, { stable: "meters", name: "d0", tags: [2] });
		expect(conn.statements).toEqual([
			"CREATE TABLE IF NOT EXISTS `d0` USING `meters` TAGS (2)",
		]);
	});
});

describe("factory — time-series points", () => {
	const meterFactory = () =>
		factory(MeterPoint, () => ({ ts: 1700000000000, current: 10.5, groupid: 2 }));

	it("make builds a plain data object", () => {
		expect(meterFactory().make()).toEqual({
			ts: 1700000000000,
			current: 10.5,
			groupid: 2,
		});
	});

	it("merge and states compose for the next build then reset", () => {
		const f = meterFactory().state("spike", (d) => {
			d.current = 999;
		});
		expect(f.merge({ groupid: 7 }).apply("spike").make()).toEqual({
			ts: 1700000000000,
			current: 999,
			groupid: 7,
		});
		// Pending merge/state reset after the build.
		expect(f.make()).toEqual({
			ts: 1700000000000,
			current: 10.5,
			groupid: 2,
		});
	});

	it("makeStubbed hydrates an instance via metadata (not `key in instance`)", () => {
		const point = meterFactory().merge({ current: 42 }).makeStubbed();
		expect(point).toBeInstanceOf(MeterPoint);
		expect(point.current).toBe(42);
		expect(point.groupid).toBe(2);
	});

	it("create persists a literal INSERT routed to the child table", async () => {
		const conn = new FakeEonConnection();
		const point = await meterFactory().create(conn);
		const child = childTableName("meters", [2]);
		expect(conn.statements).toEqual([
			`INSERT INTO \`${child}\` USING \`meters\` TAGS (2) (\`ts\`, \`current\`) VALUES (1700000000000, 10.5)`,
		]);
		expect(conn.rows(child)).toEqual([{ ts: 1700000000000, current: 10.5 }]);
		expect(point.current).toBe(10.5);
	});

	it("createMany persists each point", async () => {
		const conn = new FakeEonConnection();
		const points = await meterFactory().createMany(3, conn);
		expect(points).toHaveLength(3);
		expect(conn.statements).toHaveLength(3);
	});
});
