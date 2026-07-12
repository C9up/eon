//! DDL compilers for TDengine super-tables: CREATE / ALTER / DROP STABLE and
//! explicit child-table creation.
//!
//! CREATE / ALTER / DROP STABLE bind no params — they return plain SQL strings
//! (mirror atlas `ddl.rs`). Child-table creation *models* `?`-bound TAG values
//! (the STMT form, story 58.4), but 58.3 also renders a fully-literal form
//! (`literal: true`) so the literal-only `EonConnection.exec` (58.2 D3) can run
//! it directly (D4). Every identifier flows through `Dialect::quote_ident`, and
//! every inlined literal through `render_literal` — the injection seam stays in
//! ONE place, Rust (memory `feedback_security_first`).

use crate::builder::CompileResult;
use crate::dialect::{ColumnTypeKind, ColumnTypeSpec, Dialect};
use crate::literal::render_literal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// A super-table column or tag: a name plus its (flattened) logical type spec.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableColumnDef {
    pub name: String,
    #[serde(flatten)]
    pub type_spec: ColumnTypeSpec,
}

/// `CREATE STABLE [IF NOT EXISTS] name (columns) TAGS (tags)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStableSpec {
    pub name: String,
    pub columns: Vec<StableColumnDef>,
    pub tags: Vec<StableColumnDef>,
    #[serde(default)]
    pub if_not_exists: bool,
}

/// One `ALTER STABLE` change. TDengine takes exactly one change per statement,
/// so a spec with N changes compiles to N statements.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AlterChange {
    AddColumn {
        name: String,
        #[serde(rename = "type")]
        ty: ColumnTypeSpec,
    },
    DropColumn {
        name: String,
    },
    ModifyColumn {
        name: String,
        #[serde(rename = "type")]
        ty: ColumnTypeSpec,
    },
    AddTag {
        name: String,
        #[serde(rename = "type")]
        ty: ColumnTypeSpec,
    },
    DropTag {
        name: String,
    },
    ModifyTag {
        name: String,
        #[serde(rename = "type")]
        ty: ColumnTypeSpec,
    },
    RenameTag {
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterStableSpec {
    pub name: String,
    pub changes: Vec<AlterChange>,
}

/// `CREATE TABLE [IF NOT EXISTS] name USING stable TAGS (values)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChildTableSpec {
    pub name: String,
    pub using: String,
    pub tags: Vec<Value>,
    #[serde(default)]
    pub if_not_exists: bool,
    /// Render TAG values as inline SQL literals (58.3, for the literal-only
    /// `exec`) instead of `?` placeholders + a `params` array (the STMT form,
    /// 58.4). Default `false` = the parameterised form.
    #[serde(default)]
    pub literal: bool,
}

/// `DROP STABLE [IF EXISTS] name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropStableSpec {
    pub name: String,
    #[serde(default)]
    pub if_exists: bool,
}

/// `` `name` TYPE `` — one column or tag definition.
fn render_column(col: &StableColumnDef, dialect: Dialect) -> Result<String, String> {
    Ok(format!(
        "{} {}",
        dialect.quote_ident(&col.name)?,
        dialect.map_column_type(&col.type_spec)?
    ))
}

/// Enforce the TDengine super-table schema rules (AC5) — typed `E_*` errors,
/// never wrong SQL, never a panic. Runs before any SQL is assembled.
fn validate_stable(spec: &CreateStableSpec) -> Result<(), String> {
    // First column must be TIMESTAMP, and exactly one TIMESTAMP column exists.
    match spec.columns.first() {
        None => {
            return Err(
                "E_TS_REQUIRED: a super-table needs a first TIMESTAMP column".into(),
            )
        }
        Some(first) if first.type_spec.kind != ColumnTypeKind::Timestamp => {
            return Err(
                "E_TS_REQUIRED: the first column of a super-table must be TIMESTAMP".into(),
            )
        }
        _ => {}
    }
    let ts_count = spec
        .columns
        .iter()
        .filter(|c| c.type_spec.kind == ColumnTypeKind::Timestamp)
        .count();
    if ts_count > 1 {
        return Err(
            "E_TS_DUPLICATE: a super-table has exactly one TIMESTAMP column".into(),
        );
    }

    // A super-table requires at least one tag.
    if spec.tags.is_empty() {
        return Err("E_TAGS_REQUIRED: a super-table requires at least one tag".into());
    }

    // JSON is tag-only and, if used, must be the sole tag.
    if spec
        .columns
        .iter()
        .any(|c| c.type_spec.kind == ColumnTypeKind::Json)
    {
        return Err(
            "E_JSON_TAG_RULE: JSON is a tag-only type — it cannot be a metric column".into(),
        );
    }
    let json_tags = spec
        .tags
        .iter()
        .filter(|t| t.type_spec.kind == ColumnTypeKind::Json)
        .count();
    if json_tags > 0 && spec.tags.len() > 1 {
        return Err("E_JSON_TAG_RULE: a JSON tag must be the only tag".into());
    }

    // DECIMAL cannot be a tag (BLOB is not modelled).
    if spec
        .tags
        .iter()
        .any(|t| t.type_spec.kind == ColumnTypeKind::Decimal)
    {
        return Err("E_TYPE_NOT_TAGGABLE: DECIMAL cannot be used as a tag".into());
    }

    // No name may be used as both a column and a tag (nor duplicated within
    // either) — TDengine folds unquoted identifiers, so compare case-insensitively.
    let mut seen: HashSet<String> = HashSet::new();
    for def in spec.columns.iter().chain(spec.tags.iter()) {
        if !seen.insert(def.name.to_lowercase()) {
            return Err(format!(
                "E_NAME_COLLISION: '{}' is used more than once across columns and tags",
                def.name
            ));
        }
    }

    Ok(())
}

/// Compile `CREATE STABLE`. Returns a single-element `Vec` (uniform with ALTER).
pub fn compile_create_stable(
    spec: &CreateStableSpec,
    dialect: Dialect,
) -> Result<Vec<String>, String> {
    validate_stable(spec)?;
    let name = dialect.quote_ident(&spec.name)?;
    let columns: Vec<String> = spec
        .columns
        .iter()
        .map(|c| render_column(c, dialect))
        .collect::<Result<_, _>>()?;
    let tags: Vec<String> = spec
        .tags
        .iter()
        .map(|t| render_column(t, dialect))
        .collect::<Result<_, _>>()?;
    let if_not_exists = if spec.if_not_exists { "IF NOT EXISTS " } else { "" };
    Ok(vec![format!(
        "CREATE STABLE {}{} ({}) TAGS ({})",
        if_not_exists,
        name,
        columns.join(", "),
        tags.join(", ")
    )])
}

/// Compile `ALTER STABLE` → one statement per change.
pub fn compile_alter_stable(
    spec: &AlterStableSpec,
    dialect: Dialect,
) -> Result<Vec<String>, String> {
    if spec.changes.is_empty() {
        return Err("ALTER STABLE requires at least one change".into());
    }
    let name = dialect.quote_ident(&spec.name)?;
    spec.changes
        .iter()
        .map(|change| {
            let sql = match change {
                AlterChange::AddColumn { name: col, ty } => format!(
                    "ALTER STABLE {} ADD COLUMN {} {}",
                    name,
                    dialect.quote_ident(col)?,
                    dialect.map_column_type(ty)?
                ),
                AlterChange::DropColumn { name: col } => format!(
                    "ALTER STABLE {} DROP COLUMN {}",
                    name,
                    dialect.quote_ident(col)?
                ),
                AlterChange::ModifyColumn { name: col, ty } => format!(
                    "ALTER STABLE {} MODIFY COLUMN {} {}",
                    name,
                    dialect.quote_ident(col)?,
                    dialect.map_column_type(ty)?
                ),
                AlterChange::AddTag { name: tag, ty } => format!(
                    "ALTER STABLE {} ADD TAG {} {}",
                    name,
                    dialect.quote_ident(tag)?,
                    dialect.map_column_type(ty)?
                ),
                AlterChange::DropTag { name: tag } => format!(
                    "ALTER STABLE {} DROP TAG {}",
                    name,
                    dialect.quote_ident(tag)?
                ),
                AlterChange::ModifyTag { name: tag, ty } => format!(
                    "ALTER STABLE {} MODIFY TAG {} {}",
                    name,
                    dialect.quote_ident(tag)?,
                    dialect.map_column_type(ty)?
                ),
                AlterChange::RenameTag { from, to } => format!(
                    "ALTER STABLE {} RENAME TAG {} {}",
                    name,
                    dialect.quote_ident(from)?,
                    dialect.quote_ident(to)?
                ),
            };
            Ok(sql)
        })
        .collect()
}

/// Compile the explicit child-table create (`CREATE TABLE … USING … TAGS`).
/// With `literal: true` the tag values are inlined as typed SQL literals and the
/// `params` array is empty (58.3's `exec` path); otherwise they are `?`
/// placeholders + `params` (the STMT form, 58.4).
pub fn compile_create_child_table(
    spec: &CreateChildTableSpec,
    dialect: Dialect,
) -> Result<CompileResult, String> {
    if spec.tags.is_empty() {
        return Err(
            "E_TAGS_REQUIRED: a child table requires at least one tag value (TAGS () is invalid)"
                .into(),
        );
    }
    let name = dialect.quote_ident(&spec.name)?;
    let using = dialect.quote_ident(&spec.using)?;
    let if_not_exists = if spec.if_not_exists { "IF NOT EXISTS " } else { "" };

    let mut params: Vec<Value> = Vec::new();
    let tag_sql: Vec<String> = if spec.literal {
        spec.tags
            .iter()
            .map(render_literal)
            .collect::<Result<_, _>>()?
    } else {
        spec.tags
            .iter()
            .map(|tag| {
                params.push(tag.clone());
                dialect.placeholder(params.len() as u32)
            })
            .collect()
    };

    let sql = format!(
        "CREATE TABLE {}{} USING {} TAGS ({})",
        if_not_exists,
        name,
        using,
        tag_sql.join(", ")
    );
    Ok(CompileResult { sql, params })
}

/// Compile `DROP STABLE [IF EXISTS] name`.
pub fn compile_drop_stable(spec: &DropStableSpec, dialect: Dialect) -> Result<String, String> {
    let name = dialect.quote_ident(&spec.name)?;
    let if_exists = if spec.if_exists { "IF EXISTS " } else { "" };
    Ok(format!("DROP STABLE {}{}", if_exists, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, kind: ColumnTypeKind, length: Option<u32>) -> StableColumnDef {
        StableColumnDef {
            name: name.into(),
            type_spec: ColumnTypeSpec { kind, length, precision: None, scale: None },
        }
    }

    fn meters() -> CreateStableSpec {
        CreateStableSpec {
            name: "meters".into(),
            columns: vec![
                col("ts", ColumnTypeKind::Timestamp, None),
                col("current", ColumnTypeKind::Float, None),
                col("voltage", ColumnTypeKind::Int, None),
                col("phase", ColumnTypeKind::Varchar, Some(16)),
            ],
            tags: vec![
                col("groupid", ColumnTypeKind::Int, None),
                col("location", ColumnTypeKind::Nchar, Some(24)),
            ],
            if_not_exists: true,
        }
    }

    #[test]
    fn create_stable_is_byte_exact() {
        let stmts = compile_create_stable(&meters(), Dialect::Tdengine).unwrap();
        assert_eq!(stmts.len(), 1);
        assert_eq!(
            stmts[0],
            "CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT, `voltage` INT, `phase` VARCHAR(16)) TAGS (`groupid` INT, `location` NCHAR(24))"
        );
    }

    #[test]
    fn create_stable_without_if_not_exists() {
        let mut spec = meters();
        spec.if_not_exists = false;
        let stmts = compile_create_stable(&spec, Dialect::Tdengine).unwrap();
        assert!(stmts[0].starts_with("CREATE STABLE `meters` ("));
    }

    #[test]
    fn alter_stable_one_statement_per_change() {
        let spec = AlterStableSpec {
            name: "meters".into(),
            changes: vec![
                AlterChange::AddColumn {
                    name: "power".into(),
                    ty: ColumnTypeSpec { kind: ColumnTypeKind::Int, length: None, precision: None, scale: None },
                },
                AlterChange::DropColumn { name: "phase".into() },
                AlterChange::ModifyColumn {
                    name: "note".into(),
                    ty: ColumnTypeSpec { kind: ColumnTypeKind::Varchar, length: Some(64), precision: None, scale: None },
                },
                AlterChange::AddTag {
                    name: "region".into(),
                    ty: ColumnTypeSpec { kind: ColumnTypeKind::Nchar, length: Some(8), precision: None, scale: None },
                },
                AlterChange::DropTag { name: "location".into() },
                AlterChange::ModifyTag {
                    name: "label".into(),
                    ty: ColumnTypeSpec { kind: ColumnTypeKind::Nchar, length: Some(32), precision: None, scale: None },
                },
                AlterChange::RenameTag { from: "groupid".into(), to: "gid".into() },
            ],
        };
        let stmts = compile_alter_stable(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            stmts,
            vec![
                "ALTER STABLE `meters` ADD COLUMN `power` INT",
                "ALTER STABLE `meters` DROP COLUMN `phase`",
                "ALTER STABLE `meters` MODIFY COLUMN `note` VARCHAR(64)",
                "ALTER STABLE `meters` ADD TAG `region` NCHAR(8)",
                "ALTER STABLE `meters` DROP TAG `location`",
                "ALTER STABLE `meters` MODIFY TAG `label` NCHAR(32)",
                "ALTER STABLE `meters` RENAME TAG `groupid` `gid`",
            ]
        );
    }

    #[test]
    fn child_table_literal_form_inlines_typed_tag_values() {
        let spec = CreateChildTableSpec {
            name: "d0".into(),
            using: "meters".into(),
            tags: vec![json!(1), json!("Cali'fornia"), json!(true), Value::Null],
            if_not_exists: true,
            literal: true,
        };
        let r = compile_create_child_table(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "CREATE TABLE IF NOT EXISTS `d0` USING `meters` TAGS (1, 'Cali\\'fornia', true, NULL)"
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn child_table_param_form_binds_placeholders() {
        let spec = CreateChildTableSpec {
            name: "d0".into(),
            using: "meters".into(),
            tags: vec![json!(1), json!("CA")],
            if_not_exists: false,
            literal: false,
        };
        let r = compile_create_child_table(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "CREATE TABLE `d0` USING `meters` TAGS (?, ?)");
        assert_eq!(r.params, vec![json!(1), json!("CA")]);
    }

    #[test]
    fn drop_stable() {
        let spec = DropStableSpec { name: "meters".into(), if_exists: true };
        assert_eq!(
            compile_drop_stable(&spec, Dialect::Tdengine).unwrap(),
            "DROP STABLE IF EXISTS `meters`"
        );
    }

    // ── AC5 rejection tests — one per rule ──────────────────────────

    #[test]
    fn rejects_missing_timestamp_first_column() {
        let mut spec = meters();
        spec.columns.remove(0); // drop the ts column
        let err = compile_create_stable(&spec, Dialect::Tdengine).unwrap_err();
        assert!(err.contains("E_TS_REQUIRED"), "got: {}", err);
    }

    #[test]
    fn rejects_non_timestamp_first_column() {
        let spec = CreateStableSpec {
            name: "s".into(),
            columns: vec![col("x", ColumnTypeKind::Int, None), col("ts", ColumnTypeKind::Timestamp, None)],
            tags: vec![col("g", ColumnTypeKind::Int, None)],
            if_not_exists: false,
        };
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_TS_REQUIRED"));
    }

    #[test]
    fn rejects_duplicate_timestamp() {
        let mut spec = meters();
        spec.columns.push(col("ts2", ColumnTypeKind::Timestamp, None));
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_TS_DUPLICATE"));
    }

    #[test]
    fn rejects_stable_without_tags() {
        let mut spec = meters();
        spec.tags.clear();
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_TAGS_REQUIRED"));
    }

    #[test]
    fn rejects_varchar_without_length() {
        let mut spec = meters();
        spec.columns[3] = col("phase", ColumnTypeKind::Varchar, None);
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_LENGTH_REQUIRED"));
    }

    #[test]
    fn rejects_json_metric_column() {
        let mut spec = meters();
        spec.columns.push(col("meta", ColumnTypeKind::Json, None));
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_JSON_TAG_RULE"));
    }

    #[test]
    fn rejects_json_tag_alongside_another_tag() {
        let mut spec = meters();
        spec.tags = vec![col("info", ColumnTypeKind::Json, None), col("g", ColumnTypeKind::Int, None)];
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_JSON_TAG_RULE"));
    }

    #[test]
    fn accepts_json_as_sole_tag() {
        let mut spec = meters();
        spec.tags = vec![col("info", ColumnTypeKind::Json, None)];
        let stmts = compile_create_stable(&spec, Dialect::Tdengine).unwrap();
        assert!(stmts[0].contains("TAGS (`info` JSON)"));
    }

    #[test]
    fn rejects_decimal_tag() {
        let mut spec = meters();
        spec.tags.push(StableColumnDef {
            name: "amount".into(),
            type_spec: ColumnTypeSpec { kind: ColumnTypeKind::Decimal, length: None, precision: Some(10), scale: Some(2) },
        });
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_TYPE_NOT_TAGGABLE"));
    }

    #[test]
    fn rejects_name_collision_between_column_and_tag() {
        let mut spec = meters();
        spec.tags.push(col("current", ColumnTypeKind::Int, None)); // collides with a metric
        assert!(compile_create_stable(&spec, Dialect::Tdengine).unwrap_err().contains("E_NAME_COLLISION"));
    }

    #[test]
    fn rejects_injection_in_stable_name() {
        let mut spec = meters();
        spec.name = "meters`; DROP STABLE x".into();
        assert!(compile_create_stable(&spec, Dialect::Tdengine).is_err());
    }

    #[test]
    fn literal_child_tag_rejects_nul_byte() {
        let spec = CreateChildTableSpec {
            name: "d0".into(),
            using: "meters".into(),
            tags: vec![json!("a\0b")],
            if_not_exists: false,
            literal: true,
        };
        assert!(compile_create_child_table(&spec, Dialect::Tdengine).unwrap_err().contains("E_UNSAFE_LITERAL"));
    }
}
