/**
 * `@c9up/eon/schema` — everything a migration file needs, and nothing else.
 *
 * A migration file that only describes a schema needs none of the transport,
 * the repository or the query builder the root barrel carries. Nothing under
 * this path touches the driver — `EonMigrationRunner` takes its connection
 * structurally.
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
