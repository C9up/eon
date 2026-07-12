//! Top-level statement dispatcher — the single entry point the NAPI boundary
//! calls. TypeScript sends `{ kind: "insert" | "select", ... }`.

use crate::builder::{compile_select, CompileResult, QueryDescription};
use crate::ddl::{
    compile_alter_stable, compile_create_child_table, compile_create_stable, compile_drop_stable,
    AlterStableSpec, CreateChildTableSpec, CreateStableSpec, DropStableSpec,
};
use crate::dialect::Dialect;
use crate::dml::{compile_insert, compile_stmt_insert_template, InsertSpec, StmtInsertTemplateSpec};
use serde::{Deserialize, Serialize};

/// A statement to compile. Tagged union on `kind`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatementSpec {
    Select(QueryDescription),
    Insert(InsertSpec),
    StmtInsertTemplate(StmtInsertTemplateSpec),
    CreateStable(CreateStableSpec),
    AlterStable(AlterStableSpec),
    CreateChildTable(CreateChildTableSpec),
    DropStable(DropStableSpec),
}

/// Compiled output — one SQL string plus its bound params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledStatement {
    pub statements: Vec<String>,
    pub params: Vec<serde_json::Value>,
}

impl CompiledStatement {
    fn from_result(r: CompileResult) -> Self {
        Self { statements: vec![r.sql], params: r.params }
    }
}

pub fn compile_statement(
    spec: &StatementSpec,
    dialect: Dialect,
) -> Result<CompiledStatement, String> {
    match spec {
        StatementSpec::Select(desc) => {
            compile_select(desc, dialect).map(CompiledStatement::from_result)
        }
        StatementSpec::Insert(s) => {
            compile_insert(s, dialect).map(CompiledStatement::from_result)
        }
        StatementSpec::StmtInsertTemplate(s) => {
            compile_stmt_insert_template(s, dialect).map(CompiledStatement::from_result)
        }
        StatementSpec::CreateStable(s) => compile_create_stable(s, dialect)
            .map(|statements| CompiledStatement { statements, params: vec![] }),
        StatementSpec::AlterStable(s) => compile_alter_stable(s, dialect)
            .map(|statements| CompiledStatement { statements, params: vec![] }),
        StatementSpec::CreateChildTable(s) => {
            compile_create_child_table(s, dialect).map(CompiledStatement::from_result)
        }
        StatementSpec::DropStable(s) => compile_drop_stable(s, dialect)
            .map(|sql| CompiledStatement { statements: vec![sql], params: vec![] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dispatches_insert_from_json() {
        let json_str =
            r#"{"kind":"insert","table":"child","columns":["ts","current"],"rows":[[1,10.0]]}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(r.statements, vec!["INSERT INTO `child` (`ts`, `current`) VALUES (?, ?)"]);
        assert_eq!(r.params, vec![json!(1), json!(10.0)]);
    }

    #[test]
    fn dispatches_stmt_insert_template_from_json() {
        let json_str = r#"{"kind":"stmtInsertTemplate","using":"meters","tagColumns":["groupid"],"columns":["ts","current"]}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.statements,
            vec!["INSERT INTO ? USING `meters` (`groupid`) TAGS (?) VALUES (?, ?)"]
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn dispatches_literal_insert_from_json() {
        let json_str = r#"{"kind":"insert","table":"d0","using":"meters","tags":[2],"columns":["ts","current"],"rows":[[1700000000000,10.3]],"literal":true}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.statements,
            vec!["INSERT INTO `d0` USING `meters` TAGS (2) (`ts`, `current`) VALUES (1700000000000, 10.3)"]
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn dispatches_select_from_json() {
        let json_str = r#"{"kind":"select","table":"meters","select":["ts"],"limit":5}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(r.statements, vec!["SELECT `ts` FROM `meters` LIMIT 5"]);
        assert!(r.params.is_empty());
    }

    #[test]
    fn dispatches_create_stable_from_json() {
        let json_str = r#"{"kind":"createStable","name":"meters","columns":[{"name":"ts","kind":"timestamp"},{"name":"current","kind":"float"}],"tags":[{"name":"groupid","kind":"int"}],"ifNotExists":true}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.statements,
            vec!["CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)"]
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn dispatches_create_child_table_literal_from_json() {
        let json_str = r#"{"kind":"createChildTable","name":"d0","using":"meters","tags":[2],"literal":true}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(r.statements, vec!["CREATE TABLE `d0` USING `meters` TAGS (2)"]);
        assert!(r.params.is_empty());
    }

    #[test]
    fn dispatches_drop_stable_from_json() {
        let json_str = r#"{"kind":"dropStable","name":"meters","ifExists":true}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(r.statements, vec!["DROP STABLE IF EXISTS `meters`"]);
    }

    #[test]
    fn compiled_statement_roundtrips_through_json() {
        let json_str = r#"{"kind":"select","table":"meters"}"#;
        let spec: StatementSpec = serde_json::from_str(json_str).unwrap();
        let r = compile_statement(&spec, Dialect::Tdengine).unwrap();
        let serialized = serde_json::to_string(&r).unwrap();
        assert!(serialized.contains("\"statements\""));
        assert!(serialized.contains("\"params\""));
    }
}
