# @c9up/eon

Time-series data layer for the Ream framework. TDengine-backed, with a Rust
`eon-query` compiler core (JSON → parameterised TDengine SQL) and a ws-first
transport.

## Status

Early scaffold (Epic 58). This story (58.1) ships the package shape, the
`eon-query` compiler crate (INSERT + basic SELECT), and a thin TS facade. The
connection/transport layer, schema decorators, bulk ingest, and the time-window
query builder land in later stories.

## Architecture

- **`crates/eon-query`** — pure-Rust compiler: a JSON statement description →
  `{ statements, params }` with backtick-quoted identifiers, `?` STMT-style
  placeholders, and an identifier/injection safety seam.
- **`crates/eon-query-napi`** — single NAPI binary (`index.<suffix>.node`)
  exposing `compileStatement(specJson, dialect)`, panic-safe via `catch_unwind`.
- **`src/`** — TS facade: native loader, `compileStatementNative`, and
  `EonProvider` (agnostic — consumes the host container structurally, never
  imports `@c9up/ream`).

## Transport

Ships ws-first over `@tdengine/websocket` (`3.5.0`, wired in 58.2). Native
`taos` transport is a deferred opt-in behind the transport-agnostic contract.

## Pinned versions

- TDengine server: `3.3.6.13`
- `@tdengine/websocket`: `3.5.0`
