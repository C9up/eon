# @c9up/eon

Time-series ORM for Node.js, backed by [TDengine](https://tdengine.com). Decorator-declared models, a fluent, windowed query builder, and injection-safe SQL compiled in Rust.

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

Read with a fluent, windowed query builder, TDengine's time-window clauses included:

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
- **ws-first transport** — eon's own taosAdapter client on Node's built-in `WebSocket`: no driver package, no install script, nothing that touches the process. An `EonProvider` boot/shutdown lifecycle and container-token singletons (`eon`, `eon.connection`, `eon:<name>`).
- **Exact values** — a SQL NULL reads back as `null` for every type (text included), FLOAT and DOUBLE keep every digit, and DECIMAL round-trips exactly on every ingest path, `ingestMany` included.
- **Tracked migrations** — `EonMigrationRunner` (`migrate` / `rollback` / `reset` / `refresh` / `status` / `dryRun`), held under a migration lock so two instances booting together cannot migrate at once. TDengine has no conditional `UPDATE`, so the lock is a table's *existence*: `CREATE TABLE` without `IF NOT EXISTS` is an atomic compare-and-swap. `forceUnlock()` clears one left by a killed process.
- **Precision-safe** — nanosecond timestamps and `BIGINT` columns cross the JSON/NAPI boundary and hydrate as `bigint`, never a lossy `number`.

## Native engine

Eon compiles every statement through its Rust `eon-query` engine. Each platform's engine is its own npm package, which `@c9up/eon` lists as an optional dependency at its exact version:

| Platform | Package |
|---|---|
| Linux x64 (glibc) | `@c9up/eon-linux-x64-gnu` |
| Linux arm64 (glibc) | `@c9up/eon-linux-arm64-gnu` |
| macOS x64 | `@c9up/eon-darwin-x64` |
| macOS arm64 | `@c9up/eon-darwin-arm64` |
| Windows x64 | `@c9up/eon-win32-x64-msvc` |

Your package manager installs only the one that matches the machine (`os`, `cpu` and `libc` fields), so an install downloads one binary and needs no Rust toolchain. An install run with optional dependencies omitted (`--no-optional`, `--omit=optional`) skips it.

If the engine is missing, the first compile throws `E_EON_NAPI_NOT_FOUND`, naming the package to install (`E_EON_NAPI_UNSUPPORTED` on a platform no engine is built for, listing the supported ones). The load error itself is the exception's `cause`.

In a checkout of this repository, `pnpm build:napi` builds `index.<platform>.node` at the package root, and eon loads that file before looking for the platform package. `node scripts/platform-packages.mjs` rewrites the platform packages' manifests (`npm/<platform>/package.json`) and the optional dependencies after a version bump; CI fails when they are stale.

## Subpath exports

- `@c9up/eon` — decorators, repository, query builder, schema helpers, `compileStatementNative`.
- `@c9up/eon/provider` — `EonProvider` (default export) for the Ream container.
- `@c9up/eon/services/connection` — the module-level connection singleton.
- `@c9up/eon/testing` — test helpers.

## Connection account

`ream configure @c9up/eon` seeds `TDENGINE_USER=ream` and `TDENGINE_PASSWORD=change-me`: an application account and a placeholder that does not authenticate, never the server's `root`/`taosdata` superuser. Create the account once, as `root`, before the first boot:

```sql
ALTER USER root PASS '<a strong root password>';
CREATE USER ream PASS '<the TDENGINE_PASSWORD value>' SYSINFO 0;
CREATE DATABASE IF NOT EXISTS ream PRECISION 'ms';
GRANT ALL ON ream.* TO ream;
```

`SYSINFO 0` keeps the account out of the cluster's system information; `GRANT ALL ON ream.*` gives it what eon needs on its own database and nothing on any other: reads, writes, and the DDL that migrations and auto-created child tables run (`CREATE`/`ALTER`/`DROP` of super-tables and tables, the migration lock table). Create the database as `root` like above, or keep `createDatabase` in the config and let the account create it (`ALTER USER ream CREATEDB 1`).

The community server image (`3.3.6.13`) records these grants but does not enforce them: a non-root account there could still create users or drop another database. On that image the account is only as separate as the `root` password is secret, so changing `taosdata` (the first statement above) is the part that protects the server.

## Shutting down

`connection.close()` closes the connection's socket, and that is all a connection holds: once every connection and consumer is closed, Node can exit. `destroyEonConnector()` is kept for code that calls it and does nothing.

## Server versions

- Tested against TDengine `3.3.6.13` (taosAdapter's WebSocket API).
- `ingestMany` uses stmt2, which needs TDengine `3.3.6.0` or later; on an older server it fails with `E_EON_SERVER_VERSION` and `ingestSql` / `ingestSchemaless` still work.
- Node `24` or later, for its built-in `WebSocket`.

## License

MIT
