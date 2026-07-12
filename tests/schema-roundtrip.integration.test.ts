/**
 * Live decorator → DDL → server roundtrip against a real TDengine (AC7). Gated
 * on `EON_TEST_URL` via `describeIfTdengine`: skips in local dev without a
 * server, RUNS in CI where the docker server is present. Named
 * `*.integration.test.ts` so the NAPI unit matrix excludes it while the CI
 * integration job runs it for real (no silent skip — the roundtrip IS the point).
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import {
	Column,
	compileStatementNative,
	createChildTable,
	dropSuperTable,
	type EonConnection,
	SuperTable,
	syncSuperTable,
	Tag,
	Timestamp,
} from "../src/index.js";
import {
	connectTestEon,
	describeIfTdengine,
	resetDatabase,
} from "../src/testing/index.js";

const TEST_DB = "eon_schema_roundtrip";

@SuperTable("meters")
class Meters {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Column({ type: "int" }) declare voltage: number;
	@Tag({ type: "int" }) declare groupid: number;
}

/** Column name → its DESCRIBE row (`{ field, type, note, ... }`). */
function describeIndex(
	rows: Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
	const index = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		const field = row.field;
		if (typeof field === "string") index.set(field, row);
	}
	return index;
}

describeIfTdengine("super-table schema roundtrip (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("syncSuperTable creates the STABLE; DESCRIBE proves columns + tags", async () => {
		await syncSuperTable(conn, Meters);

		const desc = describeIndex(await conn.query("DESCRIBE `meters`"));
		expect(desc.get("ts")?.type).toBe("TIMESTAMP");
		expect(desc.get("current")?.type).toBe("FLOAT");
		expect(desc.get("voltage")?.type).toBe("INT");
		// The tag reports its TAG note; the metric columns do not.
		expect(String(desc.get("groupid")?.note)).toContain("TAG");
		expect(String(desc.get("current")?.note ?? "")).not.toContain("TAG");
	});

	it("createChildTable makes an explicit child bound to the stable", async () => {
		await createChildTable(conn, {
			EntityClass: Meters,
			name: "d0",
			tags: [1],
		});

		const rows = await conn.query(
			`SELECT table_name, stable_name FROM information_schema.ins_tables WHERE db_name = '${TEST_DB}' AND table_name = 'd0'`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.stable_name).toBe("meters");
	});

	it("insert-time USING…TAGS auto-creates the child on first insert", async () => {
		// The 58.1 child-auto-create INSERT form, run as literal via exec (58.2).
		await conn.exec(
			"INSERT INTO `d1` USING `meters` TAGS (2) VALUES (now, 9.9, 218)",
		);
		const rows = await conn.query(
			`SELECT table_name FROM information_schema.ins_tables WHERE db_name = '${TEST_DB}' AND table_name = 'd1'`,
		);
		expect(rows).toHaveLength(1);
	});

	it("ALTER STABLE ADD COLUMN is compiled + exec'd; DESCRIBE shows the new column", async () => {
		const { statements } = compileStatementNative({
			kind: "alterStable",
			name: "meters",
			changes: [
				{
					op: "addColumn",
					name: "power",
					type: { kind: "int", length: null, precision: null, scale: null },
				},
			],
		});
		for (const sql of statements) await conn.exec(sql);

		const desc = describeIndex(await conn.query("DESCRIBE `meters`"));
		expect(desc.get("power")?.type).toBe("INT");
	});

	it("dropSuperTable removes the STABLE", async () => {
		await dropSuperTable(conn, Meters);
		const rows = await conn.query(
			`SELECT stable_name FROM information_schema.ins_stables WHERE db_name = '${TEST_DB}' AND stable_name = 'meters'`,
		);
		expect(rows).toHaveLength(0);
	});
});
