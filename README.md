# @c9up/eon

Time-series ORM for Node.js, backed by [TDengine](https://tdengine.com). AdonisJS/Lucid-shaped decorators, a fluent windowed query builder, and injection-safe SQL compiled in Rust.

## Usage

Model a super-table declaratively — the same way you model an Atlas entity, plus a `@Tag` decorator for TDengine's tag columns:

```typescript
import { SuperTable, Timestamp, Column, Tag } from '@c9up/eon'

@SuperTable('meters')
class Meter {
  @Timestamp() declare ts: bigint
  @Column({ type: 'float' }) declare current: number
  @Column({ type: 'int' }) declare voltage: number
  @Tag({ type: 'int' }) declare groupId: number
  @Tag({ type: 'nchar', length: 24 }) declare location: string
}
```

Write points through the repository. Child tables are created automatically from each tag set on first insert:

```typescript
import { SuperTableRepository } from '@c9up/eon'

const meters = new SuperTableRepository(Meter, connection)

await meters.ingest({ ts: 1700000000000n, current: 10.3, voltage: 219, groupId: 2, location: 'SF' })
await meters.ingestMany(points)          // columnar STMT bulk — the default high-throughput path
```

Read with a fluent, windowed query builder (Lucid-shaped, plus TDengine's time-window clauses):

```typescript
const rows = await meters.query()
  .select([{ pseudo: '_wstart' }, { function: 'avg', column: 'voltage', alias: 'avgV' }])
  .whereBetween('ts', [start, end])
  .partitionBy('groupId')
  .interval('1m')
  .fill('prev')
  .orderBy('_wstart', 'asc')
  .limit(100)                            // thenable — `await` runs it
```

## Features

- **Decorators** — `@SuperTable`, `@Timestamp`, `@Column`, `@Tag`; metadata-driven schema (`syncSuperTable`, `createChildTable`, `dropSuperTable`) compiled to real TDengine DDL.
- **Three ingest paths** — `ingestMany` (columnar STMT, default), `ingestSchemaless` (InfluxDB line protocol), `ingestSql` (literal INSERT). Child tables auto-created per tag set.
- **Windowed query builder** — `where` / `whereBetween` / `select` (functions + `_wstart` / `_wend` / `_wduration` pseudo-columns) / `partitionBy` / `interval` / `sliding` / `fill` / `orderBy` / `limit` / `offset`; thenable; `query(mapPoint)` for typed rows.
- **Injection-safe by construction** — every identifier and value is compiled and escaped in a Rust `eon-query` core (NAPI); TypeScript never string-builds SQL.
- **ws-first transport** over `@tdengine/websocket`, with an `EonProvider` boot/shutdown lifecycle and container-token singletons (`eon`, `eon.connection`, `eon:<name>`).
- **Tracked migrations** — `EonMigrationRunner` (`migrate` / `rollback` / `reset` / `refresh` / `status` / `dryRun`), held under a migration lock so two instances booting together cannot migrate at once. TDengine has no conditional `UPDATE`, so the lock is a table's *existence*: `CREATE TABLE` without `IF NOT EXISTS` is an atomic compare-and-swap. `forceUnlock()` clears one left by a killed process.
- **Precision-safe** — nanosecond timestamps and `BIGINT` columns cross the JSON/NAPI boundary and hydrate as `bigint`, never a lossy `number`.

## Subpath exports

- `@c9up/eon` — decorators, repository, query builder, schema helpers, `compileStatementNative`.
- `@c9up/eon/provider` — `EonProvider` (default export) for the Ream container.
- `@c9up/eon/services/connection` — the module-level connection singleton.
- `@c9up/eon/testing` — test helpers.

## Shutting down

`connection.close()` closes one connection but deliberately leaves the connector's process-global handles alone, and those keep Node alive — a service that closed every connection would still hang instead of exiting. Call `destroyEonConnector()` once after the last close; `EonProvider.shutdown()` already does.

## Pinned versions

- TDengine server: `3.3.6.13`
- `@tdengine/websocket`: `3.5.0`

## License

MIT
