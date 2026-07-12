//! INSERT compiler for TDengine.
//!
//! Two forms (the plain form proven against a live TDengine 3.3.6.13 in spike
//! 58-0; both emit an explicit value-column list, TDengine-documented syntax —
//! re-confirm the child-auto-create form on the docker-gated e2e):
//!   - plain:            `INSERT INTO `child` (`ts`,`current`) VALUES (?, ?)`
//!   - child auto-create: `INSERT INTO `child` USING `meters` TAGS (?) (`ts`,`current`) VALUES (?, ?)`
//!
//! Identifiers flow through `Dialect::quote_ident` (backtick + injection reject);
//! every value/tag is a bound `?` placeholder — no caller value is ever
//! interpolated into the SQL string. TDengine has no UPDATE/DELETE/UPSERT/
//! RETURNING (D6): a same-timestamp insert overwrites.

use crate::builder::CompileResult;
use crate::dialect::Dialect;
use crate::literal::render_literal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertSpec {
    /// Target table (the child table for the auto-create form).
    pub table: String,
    /// Child-table auto-create: the super table (STABLE) name. When set, emits
    /// the `USING <using> TAGS (...)` clause; the explicit value-column list is
    /// still emitted (as in the plain form) so caller-declared `columns` map by
    /// name, never positionally onto the STABLE's own column order.
    #[serde(default)]
    pub using: Option<String>,
    /// TAG values for the child-table auto-create form. Bound BEFORE the value
    /// params. Requires `using`: supplying `tags` without `using` is rejected.
    #[serde(default)]
    pub tags: Vec<Value>,
    /// Column names — one per value in each row.
    pub columns: Vec<String>,
    /// Value rows; each row aligns positionally to `columns`.
    pub rows: Vec<Vec<Value>>,
    /// Render every tag/value as an inline SQL literal (the literal INSERT path,
    /// story 58.4, for the literal-only `EonConnection.exec`) instead of `?`
    /// placeholders + a `params` array (the STMT path). Default `false` = the
    /// parameterised form. Mirrors `CreateChildTableSpec.literal`.
    #[serde(default)]
    pub literal: bool,
}

/// A STMT *prepare template* for columnar bulk ingest (story 58.4).
///
/// The parameterised `InsertSpec` above emits one `?` per value cell, which
/// suits row-wise binding but NOT the connector's columnar STMT2 path (bind a
/// whole column array against a single `?`). This template emits the shape the
/// `@tdengine/websocket` connector prepares once and reuses across every child
/// table: `INSERT INTO ? USING <stable> (<tag cols>) TAGS (?, …) VALUES (?, …)`
/// — the table is a `?` filled by `setTableName`, one `?` per tag, one `?` per
/// value column. It binds NO params (they are supplied columnar at bind time),
/// so `params` comes back empty. Every identifier still flows through
/// `quote_ident` — the injection seam stays in Rust even for the template.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StmtInsertTemplateSpec {
    /// The super-table (STABLE) name for the `USING` clause.
    pub using: String,
    /// Tag column names — emitted as the `(…)` list before `TAGS`, one `?` each.
    pub tag_columns: Vec<String>,
    /// Value column names (ts-first). Validated + counted; drives the `VALUES`
    /// placeholder count. Bound columnar in this order at STMT bind time.
    pub columns: Vec<String>,
}

/// Compile a columnar STMT prepare template (story 58.4). See
/// [`StmtInsertTemplateSpec`]. Returns the template SQL with an empty `params`.
pub fn compile_stmt_insert_template(
    spec: &StmtInsertTemplateSpec,
    dialect: Dialect,
) -> Result<CompileResult, String> {
    if spec.tag_columns.is_empty() {
        return Err(
            "INSERT STMT template requires at least one tag column (the USING form needs TAGS)"
                .into(),
        );
    }
    if spec.columns.is_empty() {
        return Err("INSERT STMT template requires at least one value column".into());
    }
    let using = dialect.quote_ident(&spec.using)?;
    // Quote (and thereby injection-validate) every tag column name for the list.
    let tag_cols: Vec<String> = spec
        .tag_columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Result<_, _>>()?;
    // Validate every value column identifier up front (defence-in-depth) even
    // though the columnar template omits the value column list (the connector's
    // proven form binds all columns positionally, in stable order).
    for col in &spec.columns {
        dialect.quote_ident(col)?;
    }
    let tag_ph: Vec<String> = (0..tag_cols.len())
        .map(|i| dialect.placeholder(i as u32 + 1))
        .collect();
    let val_ph: Vec<String> = (0..spec.columns.len())
        .map(|i| dialect.placeholder(i as u32 + 1))
        .collect();
    let sql = format!(
        "INSERT INTO ? USING {} ({}) TAGS ({}) VALUES ({})",
        using,
        tag_cols.join(", "),
        tag_ph.join(", "),
        val_ph.join(", ")
    );
    Ok(CompileResult { sql, params: vec![] })
}

pub fn compile_insert(spec: &InsertSpec, dialect: Dialect) -> Result<CompileResult, String> {
    if spec.columns.is_empty() {
        return Err("INSERT requires at least one column".into());
    }
    if spec.rows.is_empty() {
        return Err("INSERT requires at least one row".into());
    }
    for (ri, row) in spec.rows.iter().enumerate() {
        if row.len() != spec.columns.len() {
            return Err(format!(
                "INSERT row {} has {} values but {} columns were given",
                ri,
                row.len(),
                spec.columns.len()
            ));
        }
    }
    // Child-table auto-create (`using`) and `tags` must be consistent: the
    // USING form needs at least one tag (an empty `TAGS ()` is invalid SQL),
    // and tags supplied without `using` would otherwise be silently dropped.
    match (&spec.using, spec.tags.is_empty()) {
        (Some(_), true) => {
            return Err("INSERT child-table auto-create (`using`) requires at least one tag".into());
        }
        (None, false) => {
            return Err(
                "INSERT `tags` were supplied without `using`; tags apply only to the child-table auto-create (USING … TAGS) form".into(),
            );
        }
        _ => {}
    }

    let table = dialect.quote_ident(&spec.table)?;
    // The explicit column list is emitted by BOTH the plain and the child-table
    // (`using`) forms — TDengine's `USING stb TAGS (...) (cols) VALUES (...)`
    // grammar supports it — so caller-supplied `columns` stay authoritative and
    // values are never mapped positionally onto the stable's own column order
    // (which would silently write into the wrong columns).
    let col_sql: Vec<String> = spec
        .columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Result<_, _>>()?;

    let mut params: Vec<Value> =
        Vec::with_capacity(spec.tags.len() + spec.rows.len() * spec.columns.len());

    let mut sql = match &spec.using {
        Some(stable) => {
            let stable_q = dialect.quote_ident(stable)?;
            // Tag params bind BEFORE value params.
            let tag_ph: Vec<String> = spec
                .tags
                .iter()
                .map(|t| render_value(t, spec.literal, &mut params, dialect))
                .collect::<Result<_, _>>()?;
            format!(
                "INSERT INTO {} USING {} TAGS ({}) ({})",
                table,
                stable_q,
                tag_ph.join(", "),
                col_sql.join(", ")
            )
        }
        None => format!("INSERT INTO {} ({})", table, col_sql.join(", ")),
    };

    let mut value_groups: Vec<String> = Vec::with_capacity(spec.rows.len());
    for row in &spec.rows {
        let placeholders: Vec<String> = row
            .iter()
            .map(|v| render_value(v, spec.literal, &mut params, dialect))
            .collect::<Result<_, _>>()?;
        value_groups.push(format!("({})", placeholders.join(", ")));
    }
    sql.push_str(&format!(" VALUES {}", value_groups.join(", ")));

    Ok(CompileResult { sql, params })
}

/// Render one INSERT value: an inline SQL literal (`literal`) or a `?`
/// placeholder that pushes the value onto `params`. The literal path funnels
/// through the shared `render_literal` injection seam.
fn render_value(
    value: &Value,
    literal: bool,
    params: &mut Vec<Value>,
    dialect: Dialect,
) -> Result<String, String> {
    if literal {
        render_literal(value)
    } else {
        params.push(value.clone());
        Ok(dialect.placeholder(params.len() as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(json_str: &str) -> InsertSpec {
        serde_json::from_str(json_str).unwrap()
    }

    #[test]
    fn plain_insert_is_byte_exact() {
        let s = spec(
            r#"{"table":"child","columns":["ts","current"],"rows":[[1700000000000,10.3]]}"#,
        );
        let r = compile_insert(&s, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "INSERT INTO `child` (`ts`, `current`) VALUES (?, ?)");
        assert_eq!(r.params, vec![json!(1700000000000i64), json!(10.3)]);
    }

    #[test]
    fn child_autocreate_insert_is_byte_exact() {
        let s = spec(
            r#"{"table":"child","using":"meters","tags":["California.SanFrancisco"],"columns":["ts","current"],"rows":[[1700000000000,10.3]]}"#,
        );
        let r = compile_insert(&s, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "INSERT INTO `child` USING `meters` TAGS (?) (`ts`, `current`) VALUES (?, ?)"
        );
        // Tag params bind BEFORE value params.
        assert_eq!(
            r.params,
            vec![json!("California.SanFrancisco"), json!(1700000000000i64), json!(10.3)]
        );
    }

    #[test]
    fn multi_row_insert_repeats_value_groups() {
        let s = spec(
            r#"{"table":"child","columns":["ts","current"],"rows":[[1,10.0],[2,20.0]]}"#,
        );
        let r = compile_insert(&s, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "INSERT INTO `child` (`ts`, `current`) VALUES (?, ?), (?, ?)");
        assert_eq!(r.params, vec![json!(1), json!(10.0), json!(2), json!(20.0)]);
    }

    #[test]
    fn ragged_rows_are_rejected() {
        let s = spec(r#"{"table":"child","columns":["ts","current"],"rows":[[1]]}"#);
        assert!(compile_insert(&s, Dialect::Tdengine).is_err());
    }

    #[test]
    fn using_without_tags_is_rejected() {
        let s = spec(r#"{"table":"child","using":"meters","columns":["ts"],"rows":[[1]]}"#);
        let err = compile_insert(&s, Dialect::Tdengine).unwrap_err();
        assert!(err.contains("at least one tag"), "got: {}", err);
    }

    #[test]
    fn tags_without_using_is_rejected() {
        let s = spec(r#"{"table":"child","tags":["CA"],"columns":["ts"],"rows":[[1]]}"#);
        let err = compile_insert(&s, Dialect::Tdengine).unwrap_err();
        assert!(err.contains("without `using`"), "got: {}", err);
    }

    #[test]
    fn injection_in_table_or_column_is_rejected() {
        let bad_table = spec(r#"{"table":"child`;DROP","columns":["ts"],"rows":[[1]]}"#);
        assert!(compile_insert(&bad_table, Dialect::Tdengine).is_err());
        let bad_col = spec(r#"{"table":"child","columns":["ts; DROP TABLE x"],"rows":[[1]]}"#);
        assert!(compile_insert(&bad_col, Dialect::Tdengine).is_err());
    }

    #[test]
    fn literal_insert_inlines_typed_values_with_no_params() {
        let s = spec(
            r#"{"table":"child","using":"meters","tags":["Cali'fornia"],"columns":["ts","current"],"rows":[[1700000000000,10.3]],"literal":true}"#,
        );
        let r = compile_insert(&s, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "INSERT INTO `child` USING `meters` TAGS ('Cali\\'fornia') (`ts`, `current`) VALUES (1700000000000, 10.3)"
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn literal_insert_multi_row() {
        let s = spec(
            r#"{"table":"child","columns":["ts","current"],"rows":[[1,10.0],[2,20.0]],"literal":true}"#,
        );
        let r = compile_insert(&s, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "INSERT INTO `child` (`ts`, `current`) VALUES (1, 10.0), (2, 20.0)"
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn literal_insert_rejects_nul_in_value() {
        let s = spec(
            r#"{"table":"child","columns":["ts","note"],"rows":[[1,"a\u0000b"]],"literal":true}"#,
        );
        assert!(compile_insert(&s, Dialect::Tdengine).unwrap_err().contains("E_UNSAFE_LITERAL"));
    }

    #[test]
    fn stmt_template_is_byte_exact() {
        let spec = StmtInsertTemplateSpec {
            using: "meters".into(),
            tag_columns: vec!["groupid".into(), "location".into()],
            columns: vec!["ts".into(), "current".into(), "voltage".into()],
        };
        let r = compile_stmt_insert_template(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "INSERT INTO ? USING `meters` (`groupid`, `location`) TAGS (?, ?) VALUES (?, ?, ?)"
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn stmt_template_requires_tag_and_value_columns() {
        let no_tags = StmtInsertTemplateSpec {
            using: "meters".into(),
            tag_columns: vec![],
            columns: vec!["ts".into()],
        };
        assert!(compile_stmt_insert_template(&no_tags, Dialect::Tdengine).is_err());
        let no_cols = StmtInsertTemplateSpec {
            using: "meters".into(),
            tag_columns: vec!["g".into()],
            columns: vec![],
        };
        assert!(compile_stmt_insert_template(&no_cols, Dialect::Tdengine).is_err());
    }

    #[test]
    fn stmt_template_rejects_injection_in_identifiers() {
        let bad = StmtInsertTemplateSpec {
            using: "meters`; DROP".into(),
            tag_columns: vec!["g".into()],
            columns: vec!["ts".into()],
        };
        assert!(compile_stmt_insert_template(&bad, Dialect::Tdengine).is_err());
        let bad_col = StmtInsertTemplateSpec {
            using: "meters".into(),
            tag_columns: vec!["g".into()],
            columns: vec!["ts; DROP".into()],
        };
        assert!(compile_stmt_insert_template(&bad_col, Dialect::Tdengine).is_err());
    }
}
