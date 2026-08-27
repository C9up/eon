import "reflect-metadata";

export {
	defineConfig,
	type EonConfig,
	type EonConnectionConfig,
} from "./connection/config.js";
export {
	type EonBindKind,
	type EonBoundColumn,
	type EonChildBatch,
	type EonColumnarIngest,
	type EonConnection,
	EonConnectionError,
	type EonLineProtocol,
	type EonSchemalessOptions,
	type EonSchemalessPrecision,
} from "./connection/EonConnection.js";
export {
	connectWsEon,
	destroyEonConnector,
} from "./connection/websocket.js";
export {
	Column,
	type EonColumnMetadata,
	type EonColumnOptions,
	type EonTagMetadata,
	type EonTagOptions,
	getColumnMetadata,
	getSuperTableMetadata,
	getTagMetadata,
	getTimestampColumn,
	SuperTable,
	type SuperTableMetadata,
	Tag,
	Timestamp,
} from "./decorators/superTable.js";
export type {
	EonAppContext,
	EonConnector,
	EonService,
} from "./EonProvider.js";
export { EonProvider } from "./EonProvider.js";
export {
	EonConnectionCheck,
	type EonHealthResult,
} from "./health.js";
export { toLineProtocol } from "./ingest/schemaless.js";
export { buildLiteralInserts } from "./ingest/sql.js";
export {
	buildColumnarIngest,
	type ColumnarPlan,
	compileStmtTemplate,
	DEFAULT_BATCH_SIZE,
	groupByChild,
	type IngestPoint,
	type PlanColumn,
	toBindKind,
} from "./ingest/stmt.js";
export {
	type CompiledStatement,
	compileStatementNative,
	type EonDialect,
	quoteIdentNative,
} from "./query/native.js";
export {
	type EonFillMode,
	type EonFunctionSelect,
	type EonOrderDirection,
	type EonPseudoSelect,
	type EonScalar,
	type EonSelectItem,
	type EonWhereOperator,
	type EonWhereValue,
	TimeSeriesQuery,
} from "./query/TimeSeriesQuery.js";
export {
	SuperTableRepository,
	type SuperTableRepositoryOptions,
} from "./repository/SuperTableRepository.js";
export {
	type AlterChange,
	type AlterDatabaseSpec,
	type AlterStableSpec,
	type CreateChildTableSpec,
	type CreateDatabaseSpec,
	type CreateStableSpec,
	type CreateTableSpec,
	type DropStableSpec,
	type DropTableSpec,
	type EonAlterDatabaseOptions,
	type EonCacheModel,
	type EonColumnSpec,
	type EonDatabaseOptions,
	type EonLogicalType,
	type EonPrecision,
	TYPE_KIND_MAP,
} from "./schema/CreateStableSpec.js";
export {
	compileCreateStableSpec,
	requireSuperTableName,
	type SuperTableClass,
} from "./schema/compile.js";
export {
	type EonMigrationOptions,
	EonMigrationRunner,
	type MigrationState,
	type MigrationStatus,
} from "./schema/EonMigrationRunner.js";
export {
	AlterStableBuilder,
	type AlterTypeSetter,
	BasicTableBuilder,
	EonSchema,
	StableBuilder,
	type StableColumnHandle,
} from "./schema/EonSchema.js";
export { Migration } from "./schema/Migration.js";
export {
	type CreateChildTableOptions,
	childTableName,
	createChildTable,
	dropSuperTable,
	syncSuperTable,
} from "./schema/sync.js";
export {
	type EonConsumer,
	type EonConsumerConfig,
	EonConsumerError,
	type EonMessage,
	type EonOffsetReset,
	type EonTopicPartition,
} from "./tmq/EonConsumer.js";
export { connectWsConsumer } from "./tmq/websocket.js";
