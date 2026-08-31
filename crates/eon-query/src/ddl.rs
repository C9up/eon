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

use crate::builder::{parse_duration, validate_duration, CompileResult};
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
#[serde(deny_unknown_fields)]
pub struct CreateStableSpec {
    pub name: String,
    pub columns: Vec<StableColumnDef>,
    pub tags: Vec<StableColumnDef>,
    #[serde(default)]
    pub if_not_exists: bool,
    /// Optional STABLE `KEEP` table-option (retention), emitted as a trailing
    /// `KEEP <v>`. A newer-3.3.x TDengine feature — a pre-3.3 server rejects it
    /// (58.6). Validated as a duration token; absent by default (58.3 stays byte
    /// -identical).
    #[serde(default)]
    pub keep: Option<String>,
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
#[serde(deny_unknown_fields)]
pub struct AlterStableSpec {
    pub name: String,
    pub changes: Vec<AlterChange>,
}

/// `CREATE TABLE [IF NOT EXISTS] name USING stable TAGS (values)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
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
    /// Optional child-table `TTL` in whole days (`>= 0`), emitted as a trailing
    /// `TTL <n>`. A newer-3.3.x TDengine feature — a pre-3.3 server rejects it
    /// (58.6). Absent by default.
    #[serde(default)]
    pub ttl: Option<i64>,
}

/// `DROP STABLE [IF EXISTS] name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct DropStableSpec {
    pub name: String,
    #[serde(default)]
    pub if_exists: bool,
}

/// `CREATE DATABASE [IF NOT EXISTS] db [options…]` — the retention/`KEEP`
/// deliverable (58.6). Options emit ONLY when present, in a fixed order. Every
/// value is a validated numeric/enum/duration — never an interpolated string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateDatabaseSpec {
    pub name: String,
    #[serde(default)]
    pub if_not_exists: bool,
    #[serde(default)]
    pub keep: Option<String>,
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub precision: Option<String>,
    #[serde(default)]
    pub buffer: Option<i64>,
    #[serde(default)]
    pub wal_level: Option<i64>,
    #[serde(default)]
    pub cachemodel: Option<String>,
}

/// `ALTER DATABASE db <one-option>` — TDengine takes exactly ONE option per
/// statement. `option` is matched case-insensitively against the alterable set;
/// a create-only option (`PRECISION`/`DURATION`/`VGROUPS`/`COMP`) is rejected
/// with `E_EON_IMMUTABLE_DB_OPTION` rather than silently emitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AlterDatabaseSpec {
    pub name: String,
    pub option: String,
    pub value: Value,
}

/// `CREATE TABLE [IF NOT EXISTS] name (columns)` — a plain (non-super) table,
/// NO `TAGS`. Needed by the migration runner's tracking table (58.6). Reuses the
/// timestamp-first rule but SKIPS the `>= 1 tag` rule (basic tables have none).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateTableSpec {
    pub name: String,
    pub columns: Vec<StableColumnDef>,
    #[serde(default)]
    pub if_not_exists: bool,
}

/// `DROP TABLE [IF EXISTS] name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct DropTableSpec {
    pub name: String,
    #[serde(default)]
    pub if_exists: bool,
}

/// TDengine `CACHEMODEL` allowlist — quoted string option.
const CACHEMODEL_VALUES: [&str; 4] = ["none", "last_row", "last_value", "both"];

/// Database options that are fixed at CREATE and cannot be `ALTER`ed.
const CREATE_ONLY_DB_OPTIONS: [&str; 4] = ["precision", "duration", "vgroups", "comp"];

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
    // TDengine's rule is that the FIRST column is a TIMESTAMP — it is the row
    // key. Later TIMESTAMP columns are ordinary columns and are accepted; a
    // `E_TS_DUPLICATE` check used to reject them here, which is a rule TDengine
    // does not have. It blocked the normal shape of a dated fact carrying
    // secondary dates (a dividend keyed on its ex-date also has declaration,
    // record and payment dates), forcing them into VARCHAR.
    match spec.columns.first() {
        None => return Err("E_TS_REQUIRED: a super-table needs a first TIMESTAMP column".into()),
        Some(first) if first.type_spec.kind != ColumnTypeKind::Timestamp => {
            return Err("E_TS_REQUIRED: the first column of a super-table must be TIMESTAMP".into())
        }
        _ => {}
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
    // either). eon backtick-quotes every identifier and TDengine treats
    // backtick-quoted names as case-SENSITIVE (context7 /taosdata/tdengine
    // 27-train-faq: "if enclosed in backticks, used as provided, preserving
    // case"), so `Current` and `current` are DISTINCT columns — compare names
    // exactly, never case-fold (folding would reject a legitimate schema).
    let mut seen: HashSet<&str> = HashSet::new();
    for def in spec.columns.iter().chain(spec.tags.iter()) {
        if !seen.insert(def.name.as_str()) {
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
    let if_not_exists = if spec.if_not_exists {
        "IF NOT EXISTS "
    } else {
        ""
    };
    let keep = match &spec.keep {
        Some(k) => {
            validate_duration(k, "STABLE KEEP")?;
            format!(" KEEP {}", k)
        }
        None => String::new(),
    };
    Ok(vec![format!(
        "CREATE STABLE {}{} ({}) TAGS ({}){}",
        if_not_exists,
        name,
        columns.join(", "),
        tags.join(", "),
        keep
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
    let if_not_exists = if spec.if_not_exists {
        "IF NOT EXISTS "
    } else {
        ""
    };

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

    let ttl = match spec.ttl {
        Some(n) if n < 0 => {
            return Err(format!(
                "E_EON_INVALID_TTL: child-table TTL must be a non-negative whole number of days, got {}",
                n
            ))
        }
        Some(n) => format!(" TTL {}", n),
        None => String::new(),
    };

    let sql = format!(
        "CREATE TABLE {}{} USING {} TAGS ({}){}",
        if_not_exists,
        name,
        using,
        tag_sql.join(", "),
        ttl
    );
    Ok(CompileResult { sql, params })
}

/// Compile `DROP STABLE [IF EXISTS] name`.
pub fn compile_drop_stable(spec: &DropStableSpec, dialect: Dialect) -> Result<String, String> {
    let name = dialect.quote_ident(&spec.name)?;
    let if_exists = if spec.if_exists { "IF EXISTS " } else { "" };
    Ok(format!("DROP STABLE {}{}", if_exists, name))
}

/// Extract an integer option value from a JSON `Value`, or a typed error.
fn require_int_option(value: &Value, option: &str) -> Result<i64, String> {
    value.as_i64().ok_or_else(|| {
        format!(
            "E_EON_INVALID_DB_OPTION: {} requires an integer value, got {}",
            option, value
        )
    })
}

/// A count-style option (`BUFFER`, `REPLICA`, `MINROWS`) that has no meaningful
/// zero/negative value on TDengine — reject `< 1` at compile time so the module's
/// "every value is validated" contract holds, rather than emitting `BUFFER -5`.
fn require_positive_int_option(value: &Value, option: &str) -> Result<i64, String> {
    let n = require_int_option(value, option)?;
    if n < 1 {
        return Err(format!(
            "E_EON_INVALID_DB_OPTION: {} must be a positive integer, got {}",
            option, n
        ));
    }
    Ok(n)
}

/// Extract a string option value from a JSON `Value`, or a typed error.
fn require_str_option<'a>(value: &'a Value, option: &str) -> Result<&'a str, String> {
    value.as_str().ok_or_else(|| {
        format!(
            "E_EON_INVALID_DB_OPTION: {} requires a string value, got {}",
            option, value
        )
    })
}

/// Validate a `WAL_LEVEL` value (1 or 2).
fn validate_wal_level(level: i64) -> Result<i64, String> {
    if level == 1 || level == 2 {
        Ok(level)
    } else {
        Err(format!(
            "E_EON_INVALID_WAL_LEVEL: WAL_LEVEL must be 1 or 2, got {}",
            level
        ))
    }
}

/// Validate a `CACHEMODEL` value against the allowlist, returning it verbatim.
fn validate_cachemodel(model: &str) -> Result<&str, String> {
    if CACHEMODEL_VALUES.contains(&model) {
        Ok(model)
    } else {
        Err(format!(
            "E_EON_INVALID_CACHEMODEL: CACHEMODEL must be one of {:?}, got '{}'",
            CACHEMODEL_VALUES, model
        ))
    }
}

/// Compile `CREATE DATABASE`. Options are emitted only when present, in a fixed
/// order: KEEP, DURATION, PRECISION, BUFFER, WAL_LEVEL, CACHEMODEL. Every value
/// is validated (durations via the shared 58.5 validator, enums via allowlist)
/// and rendered injection-free — string enums are the ONLY quoted values and
/// they come from closed allowlists.
pub fn compile_create_database(
    spec: &CreateDatabaseSpec,
    dialect: Dialect,
) -> Result<String, String> {
    let name = dialect.quote_ident(&spec.name)?;
    let if_not_exists = if spec.if_not_exists {
        "IF NOT EXISTS "
    } else {
        ""
    };

    let mut opts: Vec<String> = Vec::new();

    // KEEP >= 3 x DURATION when BOTH are known and share a unit (TDengine rule).
    if let (Some(keep), Some(duration)) = (&spec.keep, &spec.duration) {
        let (keep_v, keep_u) = parse_duration(keep, "KEEP")?;
        let (dur_v, dur_u) = parse_duration(duration, "DURATION")?;
        if keep_u == dur_u && keep_v < dur_v.saturating_mul(3) {
            return Err(format!(
                "E_EON_KEEP_TOO_SMALL: KEEP ('{}') must be at least 3 x DURATION ('{}')",
                keep, duration
            ));
        }
    }

    if let Some(keep) = &spec.keep {
        validate_duration(keep, "KEEP")?;
        opts.push(format!("KEEP {}", keep));
    }
    if let Some(duration) = &spec.duration {
        validate_duration(duration, "DURATION")?;
        opts.push(format!("DURATION {}", duration));
    }
    if let Some(precision) = &spec.precision {
        if !matches!(precision.as_str(), "ms" | "us" | "ns") {
            return Err(format!(
                "E_EON_INVALID_PRECISION: PRECISION must be 'ms', 'us', or 'ns', got '{}'",
                precision
            ));
        }
        opts.push(format!("PRECISION '{}'", precision));
    }
    if let Some(buffer) = spec.buffer {
        if buffer < 1 {
            return Err(format!(
                "E_EON_INVALID_DB_OPTION: BUFFER must be a positive integer, got {}",
                buffer
            ));
        }
        opts.push(format!("BUFFER {}", buffer));
    }
    if let Some(wal_level) = spec.wal_level {
        opts.push(format!("WAL_LEVEL {}", validate_wal_level(wal_level)?));
    }
    if let Some(cachemodel) = &spec.cachemodel {
        opts.push(format!("CACHEMODEL '{}'", validate_cachemodel(cachemodel)?));
    }

    let tail = if opts.is_empty() {
        String::new()
    } else {
        format!(" {}", opts.join(" "))
    };
    Ok(format!("CREATE DATABASE {}{}{}", if_not_exists, name, tail))
}

/// Compile `ALTER DATABASE db <one-option>`. The option is matched
/// case-insensitively; a create-only option is rejected with
/// `E_EON_IMMUTABLE_DB_OPTION`, an unknown option with `E_EON_UNKNOWN_DB_OPTION`.
pub fn compile_alter_database(
    spec: &AlterDatabaseSpec,
    dialect: Dialect,
) -> Result<String, String> {
    let name = dialect.quote_ident(&spec.name)?;
    let option = spec.option.to_lowercase();

    if CREATE_ONLY_DB_OPTIONS.contains(&option.as_str()) {
        return Err(format!(
            "E_EON_IMMUTABLE_DB_OPTION: '{}' is fixed at CREATE and cannot be altered",
            spec.option
        ));
    }

    let rendered = match option.as_str() {
        "keep" => {
            let v = require_str_option(&spec.value, "KEEP")?;
            validate_duration(v, "KEEP")?;
            format!("KEEP {}", v)
        }
        "buffer" => format!("BUFFER {}", require_positive_int_option(&spec.value, "BUFFER")?),
        "minrows" => format!(
            "MINROWS {}",
            require_positive_int_option(&spec.value, "MINROWS")?
        ),
        "replica" => format!(
            "REPLICA {}",
            require_positive_int_option(&spec.value, "REPLICA")?
        ),
        "wal_level" => {
            let v = require_int_option(&spec.value, "WAL_LEVEL")?;
            format!("WAL_LEVEL {}", validate_wal_level(v)?)
        }
        "cachemodel" => {
            let v = require_str_option(&spec.value, "CACHEMODEL")?;
            format!("CACHEMODEL '{}'", validate_cachemodel(v)?)
        }
        _ => {
            return Err(format!(
                "E_EON_UNKNOWN_DB_OPTION: '{}' is not an alterable database option (KEEP, BUFFER, WAL_LEVEL, CACHEMODEL, REPLICA, MINROWS)",
                spec.option
            ))
        }
    };
    Ok(format!("ALTER DATABASE {} {}", name, rendered))
}

/// Compile `CREATE TABLE [IF NOT EXISTS] name (columns)` — a plain table (no
/// tags). Enforces the timestamp-first PK rule (the FIRST column is a
/// TIMESTAMP; later ones are ordinary columns) and name-uniqueness, but NOT
/// the super-table `>= 1 tag` rule.
pub fn compile_create_table(spec: &CreateTableSpec, dialect: Dialect) -> Result<String, String> {
    match spec.columns.first() {
        None => return Err("E_TS_REQUIRED: a table needs a first TIMESTAMP column".into()),
        Some(first) if first.type_spec.kind != ColumnTypeKind::Timestamp => {
            return Err("E_TS_REQUIRED: the first column of a table must be TIMESTAMP".into())
        }
        _ => {}
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for def in &spec.columns {
        if !seen.insert(def.name.as_str()) {
            return Err(format!(
                "E_NAME_COLLISION: '{}' is used more than once across columns",
                def.name
            ));
        }
    }

    let name = dialect.quote_ident(&spec.name)?;
    let columns: Vec<String> = spec
        .columns
        .iter()
        .map(|c| render_column(c, dialect))
        .collect::<Result<_, _>>()?;
    let if_not_exists = if spec.if_not_exists {
        "IF NOT EXISTS "
    } else {
        ""
    };
    Ok(format!(
        "CREATE TABLE {}{} ({})",
        if_not_exists,
        name,
        columns.join(", ")
    ))
}

/// Compile `DROP TABLE [IF EXISTS] name`.
pub fn compile_drop_table(spec: &DropTableSpec, dialect: Dialect) -> Result<String, String> {
    let name = dialect.quote_ident(&spec.name)?;
    let if_exists = if spec.if_exists { "IF EXISTS " } else { "" };
    Ok(format!("DROP TABLE {}{}", if_exists, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, kind: ColumnTypeKind, length: Option<u32>) -> StableColumnDef {
        StableColumnDef {
            name: name.into(),
            type_spec: ColumnTypeSpec {
                kind,
                length,
                precision: None,
                scale: None,
            },
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
            keep: None,
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
                    ty: ColumnTypeSpec {
                        kind: ColumnTypeKind::Int,
                        length: None,
                        precision: None,
                        scale: None,
                    },
                },
                AlterChange::DropColumn {
                    name: "phase".into(),
                },
                AlterChange::ModifyColumn {
                    name: "note".into(),
                    ty: ColumnTypeSpec {
                        kind: ColumnTypeKind::Varchar,
                        length: Some(64),
                        precision: None,
                        scale: None,
                    },
                },
                AlterChange::AddTag {
                    name: "region".into(),
                    ty: ColumnTypeSpec {
                        kind: ColumnTypeKind::Nchar,
                        length: Some(8),
                        precision: None,
                        scale: None,
                    },
                },
                AlterChange::DropTag {
                    name: "location".into(),
                },
                AlterChange::ModifyTag {
                    name: "label".into(),
                    ty: ColumnTypeSpec {
                        kind: ColumnTypeKind::Nchar,
                        length: Some(32),
                        precision: None,
                        scale: None,
                    },
                },
                AlterChange::RenameTag {
                    from: "groupid".into(),
                    to: "gid".into(),
                },
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
            ttl: None,
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
            ttl: None,
        };
        let r = compile_create_child_table(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "CREATE TABLE `d0` USING `meters` TAGS (?, ?)");
        assert_eq!(r.params, vec![json!(1), json!("CA")]);
    }

    #[test]
    fn drop_stable() {
        let spec = DropStableSpec {
            name: "meters".into(),
            if_exists: true,
        };
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
            columns: vec![
                col("x", ColumnTypeKind::Int, None),
                col("ts", ColumnTypeKind::Timestamp, None),
            ],
            tags: vec![col("g", ColumnTypeKind::Int, None)],
            if_not_exists: false,
            keep: None,
        };
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_TS_REQUIRED"));
    }

    /// A dated fact that carries secondary dates — a dividend keyed on its
    /// ex-date also has declaration, record and payment dates. TDengine takes
    /// these as ordinary columns; only the FIRST one is the row key.
    #[test]
    fn accepts_a_secondary_timestamp_column() {
        let mut spec = meters();
        spec.columns
            .push(col("ts2", ColumnTypeKind::Timestamp, None));
        let sql = compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap()
            .join("; ");
        assert!(sql.contains("`ts2` TIMESTAMP"), "got: {}", sql);
    }

    #[test]
    fn rejects_stable_without_tags() {
        let mut spec = meters();
        spec.tags.clear();
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_TAGS_REQUIRED"));
    }

    #[test]
    fn rejects_varchar_without_length() {
        let mut spec = meters();
        spec.columns[3] = col("phase", ColumnTypeKind::Varchar, None);
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_LENGTH_REQUIRED"));
    }

    #[test]
    fn rejects_json_metric_column() {
        let mut spec = meters();
        spec.columns.push(col("meta", ColumnTypeKind::Json, None));
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_JSON_TAG_RULE"));
    }

    #[test]
    fn rejects_json_tag_alongside_another_tag() {
        let mut spec = meters();
        spec.tags = vec![
            col("info", ColumnTypeKind::Json, None),
            col("g", ColumnTypeKind::Int, None),
        ];
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_JSON_TAG_RULE"));
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
            type_spec: ColumnTypeSpec {
                kind: ColumnTypeKind::Decimal,
                length: None,
                precision: Some(10),
                scale: Some(2),
            },
        });
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_TYPE_NOT_TAGGABLE"));
    }

    #[test]
    fn rejects_name_collision_between_column_and_tag() {
        let mut spec = meters();
        spec.tags.push(col("current", ColumnTypeKind::Int, None)); // collides with a metric
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_NAME_COLLISION"));
    }

    #[test]
    fn allows_case_distinct_names() {
        // Backtick-quoted identifiers are case-SENSITIVE in TDengine, so `current`
        // and `Current` are distinct columns — the collision check must NOT fold
        // case and reject this legitimate schema.
        let mut spec = meters();
        spec.columns.push(col("Current", ColumnTypeKind::Int, None));
        let stmts = compile_create_stable(&spec, Dialect::Tdengine).unwrap();
        assert!(stmts[0].contains("`current` FLOAT") && stmts[0].contains("`Current` INT"));
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
            ttl: None,
        };
        assert!(compile_create_child_table(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_UNSAFE_LITERAL"));
    }

    // ── 58.6: STABLE KEEP + child TTL ───────────────────────────────

    #[test]
    fn create_stable_with_keep_trailer() {
        let mut spec = meters();
        spec.keep = Some("30d".into());
        let stmts = compile_create_stable(&spec, Dialect::Tdengine).unwrap();
        assert!(stmts[0].ends_with(") KEEP 30d"), "got: {}", stmts[0]);
    }

    #[test]
    fn create_stable_rejects_invalid_keep_duration() {
        let mut spec = meters();
        spec.keep = Some("30x".into());
        assert!(compile_create_stable(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_DURATION"));
    }

    #[test]
    fn child_table_with_ttl_trailer() {
        let spec = CreateChildTableSpec {
            name: "d0".into(),
            using: "meters".into(),
            tags: vec![json!(2)],
            if_not_exists: true,
            literal: true,
            ttl: Some(7),
        };
        let r = compile_create_child_table(&spec, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "CREATE TABLE IF NOT EXISTS `d0` USING `meters` TAGS (2) TTL 7"
        );
    }

    #[test]
    fn child_table_rejects_negative_ttl() {
        let spec = CreateChildTableSpec {
            name: "d0".into(),
            using: "meters".into(),
            tags: vec![json!(2)],
            if_not_exists: false,
            literal: true,
            ttl: Some(-1),
        };
        assert!(compile_create_child_table(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_TTL"));
    }

    // ── 58.6: database DDL (KEEP / retention) ───────────────────────

    fn db(name: &str) -> CreateDatabaseSpec {
        CreateDatabaseSpec {
            name: name.into(),
            if_not_exists: false,
            keep: None,
            duration: None,
            precision: None,
            buffer: None,
            wal_level: None,
            cachemodel: None,
        }
    }

    #[test]
    fn create_database_bare() {
        assert_eq!(
            compile_create_database(&db("metrics"), Dialect::Tdengine).unwrap(),
            "CREATE DATABASE `metrics`"
        );
    }

    #[test]
    fn create_database_all_options_stable_order() {
        let spec = CreateDatabaseSpec {
            name: "metrics".into(),
            if_not_exists: true,
            keep: Some("90d".into()),
            duration: Some("10d".into()),
            precision: Some("ms".into()),
            buffer: Some(256),
            wal_level: Some(1),
            cachemodel: Some("last_row".into()),
        };
        assert_eq!(
            compile_create_database(&spec, Dialect::Tdengine).unwrap(),
            "CREATE DATABASE IF NOT EXISTS `metrics` KEEP 90d DURATION 10d PRECISION 'ms' BUFFER 256 WAL_LEVEL 1 CACHEMODEL 'last_row'"
        );
    }

    #[test]
    fn create_database_keep_must_be_three_times_duration() {
        let mut spec = db("metrics");
        spec.keep = Some("20d".into());
        spec.duration = Some("10d".into()); // 20 < 3*10
        assert!(compile_create_database(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_KEEP_TOO_SMALL"));
    }

    #[test]
    fn create_database_keep_ge_three_duration_passes() {
        let mut spec = db("metrics");
        spec.keep = Some("30d".into());
        spec.duration = Some("10d".into()); // 30 == 3*10
        assert_eq!(
            compile_create_database(&spec, Dialect::Tdengine).unwrap(),
            "CREATE DATABASE `metrics` KEEP 30d DURATION 10d"
        );
    }

    #[test]
    fn create_database_keep_duration_different_units_skips_ratio_check() {
        // Cannot compare weeks vs days without unit conversion — do NOT reject.
        let mut spec = db("metrics");
        spec.keep = Some("1w".into());
        spec.duration = Some("10d".into());
        assert!(compile_create_database(&spec, Dialect::Tdengine).is_ok());
    }

    #[test]
    fn create_database_rejects_invalid_precision() {
        let mut spec = db("metrics");
        spec.precision = Some("s".into());
        assert!(compile_create_database(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_PRECISION"));
    }

    #[test]
    fn create_database_rejects_invalid_cachemodel() {
        let mut spec = db("metrics");
        spec.cachemodel = Some("sometimes".into());
        assert!(compile_create_database(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_CACHEMODEL"));
    }

    #[test]
    fn create_database_rejects_invalid_wal_level() {
        let mut spec = db("metrics");
        spec.wal_level = Some(3);
        assert!(compile_create_database(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_WAL_LEVEL"));
    }

    #[test]
    fn create_database_rejects_injection_in_name() {
        let spec = db("metrics`; DROP DATABASE x");
        assert!(compile_create_database(&spec, Dialect::Tdengine).is_err());
    }

    fn alter_db(name: &str, option: &str, value: Value) -> AlterDatabaseSpec {
        AlterDatabaseSpec {
            name: name.into(),
            option: option.into(),
            value,
        }
    }

    #[test]
    fn alter_database_keep() {
        assert_eq!(
            compile_alter_database(
                &alter_db("metrics", "KEEP", json!("60d")),
                Dialect::Tdengine
            )
            .unwrap(),
            "ALTER DATABASE `metrics` KEEP 60d"
        );
    }

    #[test]
    fn alter_database_buffer_and_cachemodel() {
        assert_eq!(
            compile_alter_database(
                &alter_db("metrics", "buffer", json!(512)),
                Dialect::Tdengine
            )
            .unwrap(),
            "ALTER DATABASE `metrics` BUFFER 512"
        );
        assert_eq!(
            compile_alter_database(
                &alter_db("metrics", "cachemodel", json!("both")),
                Dialect::Tdengine
            )
            .unwrap(),
            "ALTER DATABASE `metrics` CACHEMODEL 'both'"
        );
    }

    #[test]
    fn database_count_options_reject_non_positive() {
        // BUFFER/REPLICA/MINROWS have no meaningful zero/negative value — reject
        // at compile time on both the CREATE and ALTER paths (never emit `BUFFER -5`).
        let mut create = db("metrics");
        create.buffer = Some(0);
        assert!(compile_create_database(&create, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_DB_OPTION"));
        for opt in ["buffer", "replica", "minrows"] {
            let err =
                compile_alter_database(&alter_db("metrics", opt, json!(-1)), Dialect::Tdengine)
                    .unwrap_err();
            assert!(
                err.contains("E_EON_INVALID_DB_OPTION"),
                "opt {}: {}",
                opt,
                err
            );
        }
    }

    #[test]
    fn alter_database_rejects_create_only_option() {
        for opt in ["precision", "duration", "vgroups", "comp"] {
            let err =
                compile_alter_database(&alter_db("metrics", opt, json!("ms")), Dialect::Tdengine)
                    .unwrap_err();
            assert!(
                err.contains("E_EON_IMMUTABLE_DB_OPTION"),
                "opt {}: {}",
                opt,
                err
            );
        }
    }

    #[test]
    fn alter_database_rejects_unknown_option() {
        assert!(compile_alter_database(
            &alter_db("metrics", "nonsense", json!(1)),
            Dialect::Tdengine
        )
        .unwrap_err()
        .contains("E_EON_UNKNOWN_DB_OPTION"));
    }

    #[test]
    fn alter_database_rejects_invalid_keep() {
        assert!(compile_alter_database(
            &alter_db("metrics", "KEEP", json!("30x")),
            Dialect::Tdengine
        )
        .unwrap_err()
        .contains("E_EON_INVALID_DURATION"));
    }

    // ── 58.6: basic (non-super) table DDL ───────────────────────────

    fn basic_tracking() -> CreateTableSpec {
        CreateTableSpec {
            name: "ream_eon_migrations".into(),
            columns: vec![
                col("executed_at", ColumnTypeKind::Timestamp, None),
                col("name", ColumnTypeKind::Varchar, Some(255)),
                col("batch", ColumnTypeKind::Int, None),
            ],
            if_not_exists: true,
        }
    }

    #[test]
    fn create_basic_table_is_byte_exact() {
        assert_eq!(
            compile_create_table(&basic_tracking(), Dialect::Tdengine).unwrap(),
            "CREATE TABLE IF NOT EXISTS `ream_eon_migrations` (`executed_at` TIMESTAMP, `name` VARCHAR(255), `batch` INT)"
        );
    }

    #[test]
    fn create_basic_table_requires_timestamp_first() {
        let mut spec = basic_tracking();
        spec.columns.remove(0);
        assert!(compile_create_table(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_TS_REQUIRED"));
    }

    #[test]
    fn create_basic_table_rejects_duplicate_name() {
        let mut spec = basic_tracking();
        spec.columns.push(col("name", ColumnTypeKind::Int, None));
        assert!(compile_create_table(&spec, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_NAME_COLLISION"));
    }

    #[test]
    fn create_basic_table_rejects_injection() {
        let mut spec = basic_tracking();
        spec.name = "t`; DROP TABLE x".into();
        assert!(compile_create_table(&spec, Dialect::Tdengine).is_err());
    }

    #[test]
    fn drop_basic_table() {
        let spec = DropTableSpec {
            name: "ream_eon_migrations".into(),
            if_exists: true,
        };
        assert_eq!(
            compile_drop_table(&spec, Dialect::Tdengine).unwrap(),
            "DROP TABLE IF EXISTS `ream_eon_migrations`"
        );
    }
}
