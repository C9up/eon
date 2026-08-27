/**
 * `@c9up/eon/schema` — everything a migration file needs, and nothing else.
 *
 * The root barrel re-exports `connectWsEon`, so importing `Migration` from
 * `@c9up/eon` loads `@tdengine/websocket` as a side effect: a migration that
 * only describes a schema pays for the driver. Nothing under this path touches
 * the driver — `EonMigrationRunner` takes its connection structurally.
 *
 * Mirrors `@c9up/atlas/schema`.
 */
export {
	type CreateStableSpec,
	type CreateTableSpec,
	TYPE_KIND_MAP,
} from "./CreateStableSpec.js";
export {
	type EonMigrationOptions,
	EonMigrationRunner,
	type MigrationState,
	type MigrationStatus,
} from "./EonMigrationRunner.js";
export {
	AlterStableBuilder,
	BasicTableBuilder,
	EonSchema,
	StableBuilder,
} from "./EonSchema.js";
export { Migration } from "./Migration.js";
