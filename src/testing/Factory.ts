/**
 * `factory` / `FactoryBuilder` — Lucid/atlas-shaped test-data factory for
 * time-series points (58.6), mirroring atlas `testing/Factory.ts`.
 *
 * Named states, ad-hoc merges, stubbing (build without persisting), and a
 * minimal `create`/`createMany` that persists through a literal `INSERT` via
 * `EonConnection.exec` — working against a {@link FakeEonConnection} OR a real
 * one. Hydration resolves columns/tags via the 58.3 metadata getters, NEVER
 * `key in instance` (the `@Column() declare x` pitfall, memory
 * `project_atlas_declare_hydration`).
 *
 * Named boundary: `create()` is a TEST-ONLY insert, NOT the 58.4
 * `SuperTableRepository` ingest API — the two coexist (the factory stays
 * test-scoped) once a live repository is in play.
 */

import type { EonConnection } from "../connection/EonConnection.js";
import {
	getColumnMetadata,
	getTagMetadata,
	getTimestampColumn,
} from "../decorators/superTable.js";
import { compileStatementNative } from "../query/native.js";
import {
	orderTimestampFirst,
	requireSuperTableName,
} from "../schema/compile.js";
import { childTableName } from "../schema/sync.js";

/** A concrete, `@SuperTable`-decorated point class (has a no-arg constructor). */
type PointConstructor<T extends object> = (new () => T) & {
	readonly name: string;
};

/** A named state — mutates an in-progress data object in place. */
type StateFn = (data: Record<string, unknown>) => void;

export interface FactoryBuilder<T extends object> {
	/** Override fields for the NEXT build (reset after consumption). */
	merge(overrides: Record<string, unknown>): FactoryBuilder<T>;
	/** Declare a named variation, stored on the factory's state map. */
	state(name: string, fn: StateFn): FactoryBuilder<T>;
	/** Activate declared states for the NEXT build (compose in order; reset after). */
	apply(...names: string[]): FactoryBuilder<T>;
	/** Build a data object without persisting or instantiating. */
	make(): Record<string, unknown>;
	/** Build `count` data objects without persisting. */
	makeMany(count: number): Record<string, unknown>[];
	/** Build an INSTANCE without persisting (Lucid `makeStubbed`). */
	makeStubbed(): T;
	/** Build + persist a single point through `conn.exec` (literal INSERT). */
	create(conn: EonConnection): Promise<T>;
	/** Build + persist `count` points. */
	createMany(count: number, conn: EonConnection): Promise<T[]>;
}

export function factory<T extends object>(
	EntityClass: PointConstructor<T>,
	defaults: () => Record<string, unknown>,
): FactoryBuilder<T> {
	const states = new Map<string, StateFn>();
	let pendingOverrides: Record<string, unknown> = {};
	let pendingStates: string[] = [];

	const buildData = (): Record<string, unknown> => {
		const data: Record<string, unknown> = {
			...defaults(),
			...pendingOverrides,
		};
		for (const name of pendingStates) {
			const fn = states.get(name);
			if (!fn) {
				throw new Error(
					`[E_EON_FACTORY_STATE] state '${name}' is not defined on ${EntityClass.name}Factory`,
				);
			}
			fn(data);
		}
		return data;
	};

	const resetPending = (): void => {
		pendingOverrides = {};
		pendingStates = [];
	};

	/** Hydrate an instance from data, assigning only declared columns/tags. */
	const hydrate = (data: Record<string, unknown>): T => {
		const instance = new EntityClass();
		const known = new Set<string>([
			...getColumnMetadata(EntityClass).map((c) => c.propertyKey),
			...getTagMetadata(EntityClass).map((t) => t.propertyKey),
		]);
		const assignable: Record<string, unknown> = {};
		for (const key of known) {
			if (key in data) assignable[key] = data[key];
		}
		Object.assign(instance, assignable);
		return instance;
	};

	const persist = async (
		conn: EonConnection,
		data: Record<string, unknown>,
	): Promise<T> => {
		const stable = requireSuperTableName(EntityClass);
		const tsProperty = getTimestampColumn(EntityClass);
		if (tsProperty === undefined) {
			throw new Error(
				`[E_EON_NO_TIMESTAMP] super-table '${stable}' has no @Timestamp column`,
			);
		}
		const columns = getColumnMetadata(EntityClass);
		const tsColumn = columns.find((c) => c.propertyKey === tsProperty);
		if (tsColumn === undefined) {
			throw new Error(
				`[E_EON_NO_TIMESTAMP] super-table '${stable}' @Timestamp column '${tsProperty}' is not registered`,
			);
		}
		const ordered = orderTimestampFirst(columns, tsColumn, tsProperty);
		const tags = getTagMetadata(EntityClass);
		const tagValues = tags.map((t) => data[t.propertyKey] ?? null);
		const table = childTableName(stable, tagValues);
		const row = ordered.map((c) => data[c.propertyKey] ?? null);

		const { statements } = compileStatementNative(
			{
				kind: "insert",
				table,
				using: stable,
				tags: tagValues,
				columns: ordered.map((c) => c.propertyKey),
				rows: [row],
				literal: true,
			},
			"tdengine",
		);
		for (const sql of statements) await conn.exec(sql);
		return hydrate(data);
	};

	const builder: FactoryBuilder<T> = {
		merge(overrides) {
			pendingOverrides = { ...pendingOverrides, ...overrides };
			return builder;
		},
		state(name, fn) {
			states.set(name, fn);
			return builder;
		},
		apply(...names) {
			pendingStates.push(...names);
			return builder;
		},
		make() {
			const data = buildData();
			resetPending();
			return data;
		},
		makeMany(count) {
			const rows: Record<string, unknown>[] = [];
			for (let i = 0; i < count; i++) rows.push(buildData());
			resetPending();
			return rows;
		},
		makeStubbed() {
			const data = buildData();
			resetPending();
			return hydrate(data);
		},
		async create(conn) {
			const data = buildData();
			resetPending();
			return persist(conn, data);
		},
		async createMany(count, conn) {
			const rows: Record<string, unknown>[] = [];
			for (let i = 0; i < count; i++) rows.push(buildData());
			resetPending();
			const created: T[] = [];
			for (const data of rows) created.push(await persist(conn, data));
			return created;
		},
	};
	return builder;
}
