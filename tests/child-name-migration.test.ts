import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
	Column,
	childTableName,
	legacyChildTableName,
	migrateChildTableNames,
	SuperTable,
	Tag,
	Timestamp,
} from "../src/index.js";
import { FakeEonConnection } from "../src/testing/index.js";

@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Tag({ type: "nchar", length: 32 }) declare device: string;
}

/** The fake does not answer the child listing; this one serves a canned one. */
class ListingConnection extends FakeEonConnection {
	readonly #children: Record<string, unknown>[];
	readonly queries: string[] = [];

	constructor(children: Record<string, unknown>[]) {
		super();
		this.#children = children;
	}

	override query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	override async query(sql: string): Promise<Record<string, unknown>[]> {
		this.queries.push(sql);
		if (sql.startsWith("SELECT DISTINCT TBNAME")) return this.#children;
		return super.query(sql);
	}
}

describe("migrateChildTableNames (bug 019)", () => {
	const legacy = legacyChildTableName("meters", ["dev-1"]);
	const next = childTableName("meters", ["dev-1"]);
	const already = childTableName("meters", ["dev-2"]);

	it("lists children with their tags, copies legacy ones and drops them", async () => {
		const conn = new ListingConnection([
			{ eon_child_name: legacy, device: "dev-1" },
			{ eon_child_name: already, device: "dev-2" },
			{ eon_child_name: "custom_child", device: "dev-3" },
		]);
		const report = await migrateChildTableNames(conn, Meter);

		expect(conn.queries).toEqual([
			"SELECT DISTINCT TBNAME AS eon_child_name, `device` FROM `meters`",
		]);
		expect(report).toEqual({
			renamed: [{ from: legacy, to: next, tags: ["dev-1"] }],
			current: [already],
			unmatched: ["custom_child"],
		});
		expect(conn.statements).toEqual([
			`CREATE TABLE IF NOT EXISTS \`${next}\` USING \`meters\` TAGS ('dev-1')`,
			`INSERT INTO \`${next}\` (\`ts\`, \`current\`) SELECT \`ts\`, \`current\` FROM \`${legacy}\``,
			`DROP TABLE IF EXISTS \`${legacy}\``,
		]);
	});

	it("writes nothing under dryRun", async () => {
		const conn = new ListingConnection([
			{ eon_child_name: legacy, device: "dev-1" },
		]);
		const report = await migrateChildTableNames(conn, Meter, { dryRun: true });
		expect(report.renamed).toEqual([
			{ from: legacy, to: next, tags: ["dev-1"] },
		]);
		expect(conn.statements).toEqual([]);
	});

	it("refuses a listing row without a table name", async () => {
		const conn = new ListingConnection([{ device: "dev-1" }]);
		await expect(migrateChildTableNames(conn, Meter)).rejects.toMatchObject({
			code: "E_EON_CHILD_MIGRATION",
		});
	});
});
