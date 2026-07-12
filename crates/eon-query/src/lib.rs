//! eon-query — TDengine SQL compiler in Rust.
//!
//! Receives a JSON statement description (from the TypeScript facade) and
//! produces parameterised TDengine SQL: backtick identifier quoting, `?` STMT
//! placeholders, and an identifier/operator injection seam. Compiler-only —
//! transport (the ws-first driver) lives in `@c9up/eon`'s TS layer (58.2).

pub mod builder;
pub mod ddl;
pub mod dialect;
pub mod dml;
pub mod identifier;
pub mod literal;
pub mod statement;

pub use builder::{compile_select, CompileResult, QueryDescription, WhereClause};
pub use ddl::{
    compile_alter_stable, compile_create_child_table, compile_create_stable, compile_drop_stable,
    AlterChange, AlterStableSpec, CreateChildTableSpec, CreateStableSpec, DropStableSpec,
    StableColumnDef,
};
pub use dialect::{ColumnTypeKind, ColumnTypeSpec, Dialect};
pub use dml::{compile_insert, compile_stmt_insert_template, InsertSpec, StmtInsertTemplateSpec};
pub use identifier::validate_operator;
pub use statement::{compile_statement, CompiledStatement, StatementSpec};
