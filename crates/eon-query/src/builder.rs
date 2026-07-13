//! SELECT builder — compiles a query description into TDengine SQL.
//!
//! 58.1 shipped `SELECT <cols> FROM <table> [WHERE ...] [LIMIT n]` with backtick
//! identifiers and `?` placeholders. 58.5 EXTENDS it with the TDengine time-window
//! clauses (`PARTITION BY` / `INTERVAL` / `SLIDING` / `FILL`), structured/safe
//! SELECT-list functions + pseudo-columns, `ORDER BY`, `OFFSET`, and a
//! literal-render mode for reads.
//!
//! READ CRUX (story 58.5): `EonConnection.query(sql)` is literal-SQL-only — the
//! ws transport binds `?` exclusively through the STMT/write path. So the
//! TypeScript builder sets `literal: true`, and WHERE / IN / FILL(VALUE …)
//! constants render as inline SQL literals through the shared `render_literal`
//! injection seam (never TS interpolation, memory `feedback_security_first`).
//! The default (`literal: false`) keeps the 58.1 `?`-placeholder form.

use crate::dialect::Dialect;
use crate::identifier::validate_operator;
use crate::literal::render_literal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhereClause {
    pub column: String,
    #[serde(default = "default_eq")]
    pub operator: String,
    #[serde(default)]
    pub value: Value,
    #[serde(rename = "type", default = "default_and")]
    pub clause_type: String,
}

fn default_eq() -> String {
    "=".to_string()
}
fn default_and() -> String {
    "and".to_string()
}
fn default_select() -> Vec<SelectItem> {
    vec![SelectItem::Column("*".to_string())]
}
fn default_asc() -> String {
    "asc".to_string()
}

/// TDengine SELECT-list pseudo-columns rendered VERBATIM (never backtick-quoted —
/// quoting turns `_wstart` into a lookup for a non-existent real column). `tbname`
/// is the child-table-name selector / partition key. This is the passthrough
/// allowlist; anything else is a normal identifier through `quote_ident`.
const PSEUDO_COLUMNS: &[&str] = &["_wstart", "_wend", "_wduration", "tbname"];

/// Aggregate / selector functions valid in a windowed SELECT list. Rendered
/// UPPERCASE with the argument quoted through `quote_ident`. No raw passthrough —
/// an unknown name is a typed error, never interpolated SQL.
const SELECT_FUNCTIONS: &[&str] = &[
    "avg", "sum", "min", "max", "count", "first", "last", "last_row", "spread", "twa",
];

/// FILL modes in scope (58.5). `NEAR` is INTERP-only and explicitly rejected;
/// `_F` force variants and `SURROUND` are out of scope.
const FILL_MODES: &[&str] = &["NONE", "NULL", "PREV", "NEXT", "LINEAR", "VALUE"];

/// A SELECT-list item — either a bare column / pseudo-column name (string form,
/// backward-compatible with 58.1's `select: ["ts", …]`) or a structured, safe
/// function / pseudo / aliased expression (58.5, AC5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SelectItem {
    /// A bare column, `*`, or a pseudo-column (`_wstart`, `tbname`, …).
    Column(String),
    /// A structured expression: a function call, a pseudo-column, or an aliased
    /// column. Never a raw string passthrough (that would reopen the injection
    /// seam).
    Expr(SelectExpr),
}

/// A structured SELECT expression. Exactly one of `function` / `pseudo` /
/// (bare) `column` selects the shape; `alias` is optional and quoted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SelectExpr {
    #[serde(default)]
    pub function: Option<String>,
    #[serde(default)]
    pub column: Option<String>,
    #[serde(default)]
    pub pseudo: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
}

/// INTERVAL specification — a bare duration token (`"1m"`) or a `{ value, offset }`
/// window with an optional offset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Interval {
    Simple(String),
    WithOffset {
        value: String,
        #[serde(default)]
        offset: Option<String>,
    },
}

/// FILL specification — a mode plus (for `VALUE`) the fill constants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub mode: String,
    #[serde(default)]
    pub values: Vec<Value>,
}

/// ORDER BY term.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBy {
    pub column: String,
    #[serde(default = "default_asc")]
    pub direction: String,
}

/// A SELECT query description sent from TypeScript. Unknown fields are REJECTED:
/// eon's TS builder and this Rust engine ship as one NAPI artifact (no version
/// skew), so a stray key is a bug — most dangerously a misspelled `limit`, which
/// would silently drop the bound and full-scan the series. Fail loud instead.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct QueryDescription {
    pub table: String,
    #[serde(default = "default_select")]
    pub select: Vec<SelectItem>,
    #[serde(default)]
    pub wheres: Vec<WhereClause>,
    #[serde(default)]
    pub partition_by: Vec<String>,
    #[serde(default)]
    pub interval: Option<Interval>,
    #[serde(default)]
    pub sliding: Option<String>,
    #[serde(default)]
    pub fill: Option<Fill>,
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub offset: Option<u64>,
    /// Render WHERE / IN values as inline SQL literals (the literal-only read
    /// path, story 58.5) instead of `?` placeholders + a `params` array. Default
    /// `false` = the 58.1 parameterised form. Mirrors `InsertSpec.literal`.
    #[serde(default)]
    pub literal: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CompileResult {
    pub sql: String,
    pub params: Vec<Value>,
}

pub fn compile_select(desc: &QueryDescription, dialect: Dialect) -> Result<CompileResult, String> {
    // Window-clause dependency rules (AC2, AC3): SLIDING and FILL are sub-clauses
    // of INTERVAL and are a TDengine syntax error standalone — reject before we
    // emit anything, never miscompile.
    if desc.sliding.is_some() && desc.interval.is_none() {
        return Err(
            "E_EON_SLIDING_REQUIRES_INTERVAL: SLIDING(...) is only valid inside an INTERVAL window"
                .into(),
        );
    }
    if desc.fill.is_some() && desc.interval.is_none() {
        return Err(
            "E_EON_FILL_REQUIRES_INTERVAL: FILL(...) is an INTERVAL sub-clause and cannot appear without INTERVAL"
                .into(),
        );
    }
    // OFFSET only exists as the tail of `LIMIT n OFFSET m` (AC6).
    if desc.offset.is_some() && desc.limit.is_none() {
        return Err(
            "E_EON_OFFSET_REQUIRES_LIMIT: OFFSET requires a LIMIT (TDengine `LIMIT n OFFSET m`)"
                .into(),
        );
    }

    let mut params: Vec<Value> = Vec::new();

    // SELECT list. An explicit empty `select: []` (as opposed to an absent field,
    // which serde defaults to `*`) must not compile to `SELECT  FROM …`.
    let select_cols: Vec<String> = if desc.select.is_empty() {
        vec!["*".to_string()]
    } else {
        desc.select
            .iter()
            .map(|item| render_select_item(item, dialect))
            .collect::<Result<_, _>>()?
    };
    let table = dialect.quote_ident(&desc.table)?;
    let mut sql = format!("SELECT {} FROM {}", select_cols.join(", "), table);

    // WHERE
    if !desc.wheres.is_empty() {
        let mut clauses: Vec<String> = Vec::with_capacity(desc.wheres.len());
        for (i, w) in desc.wheres.iter().enumerate() {
            // The first clause is always `WHERE`; its `type` is unused. For the
            // rest the connector is a strict allowlist — an unknown value (typo,
            // `"xor"`) is rejected, never silently coerced to `AND` (quietly
            // wrong result sets), matching the operator-allowlist discipline.
            let prefix = if i == 0 {
                "WHERE"
            } else {
                match w.clause_type.to_ascii_lowercase().as_str() {
                    "and" => "AND",
                    "or" => "OR",
                    other => {
                        return Err(format!(
                            "E_INVALID_CLAUSE_TYPE: WHERE connector must be 'and' or 'or', got '{}'",
                            other
                        ));
                    }
                }
            };
            let op = validate_operator(&w.operator)?;
            // Route through render_column_ref (not raw quote_ident) so a WHERE on
            // `tbname` / `_wstart` etc. matches the pseudo-column allowlist and is
            // passed verbatim, consistent with SELECT / PARTITION BY / ORDER BY.
            let col = render_column_ref(&w.column, dialect)?;
            match op {
                "IS NULL" => clauses.push(format!("{} {} IS NULL", prefix, col)),
                "IS NOT NULL" => clauses.push(format!("{} {} IS NOT NULL", prefix, col)),
                "IN" | "NOT IN" => {
                    let arr = w
                        .value
                        .as_array()
                        .ok_or_else(|| format!("{} operator requires an array value", op))?;
                    if arr.is_empty() {
                        let expr = if op == "IN" { "1 = 0" } else { "1 = 1" };
                        clauses.push(format!("{} {}", prefix, expr));
                    } else {
                        let rendered: Vec<String> = arr
                            .iter()
                            .map(|v| {
                                // Mirror the scalar arm: an array/object element is
                                // ill-typed, and a null element silently never matches
                                // inside `IN (...)`. Reject rather than emit a dead value.
                                if v.is_array() || v.is_object() {
                                    return Err(format!(
                                        "E_INVALID_WHERE_VALUE: '{}' list element must be a scalar, not a JSON {}",
                                        op,
                                        if v.is_array() { "array" } else { "object" }
                                    ));
                                }
                                if v.is_null() {
                                    return Err(format!(
                                        "E_INVALID_WHERE_VALUE: '{}' list contains a null element, which never matches; remove it or use 'IS NULL'",
                                        op
                                    ));
                                }
                                render_where_value(v, desc.literal, &mut params, dialect)
                            })
                            .collect::<Result<_, _>>()?;
                        clauses.push(format!(
                            "{} {} {} ({})",
                            prefix,
                            col,
                            op,
                            rendered.join(", ")
                        ));
                    }
                }
                _ => {
                    // Scalar operators take exactly one value; a JSON array/object
                    // value is only meaningful for IN/NOT IN (handled above).
                    if w.value.is_array() || w.value.is_object() {
                        return Err(format!(
                            "E_INVALID_WHERE_VALUE: operator '{}' requires a scalar value, not a JSON {}",
                            op,
                            if w.value.is_array() { "array" } else { "object" }
                        ));
                    }
                    // A null bound to `col = ?` never matches (SQL `= NULL`) — the
                    // query would silently return zero rows. Reject and steer to
                    // the explicit null predicates instead of miscompiling.
                    if w.value.is_null() {
                        return Err(format!(
                            "E_INVALID_WHERE_VALUE: operator '{}' with a null value never matches; use 'IS NULL' / 'IS NOT NULL'",
                            op
                        ));
                    }
                    let rendered = render_where_value(&w.value, desc.literal, &mut params, dialect)?;
                    clauses.push(format!("{} {} {} {}", prefix, col, op, rendered));
                }
            }
        }
        sql.push(' ');
        sql.push_str(&clauses.join(" "));
    }

    // PARTITION BY — after WHERE, before the window clause (partition-then-window;
    // emitting it after INTERVAL is a TDengine syntax error).
    if !desc.partition_by.is_empty() {
        let cols: Vec<String> = desc
            .partition_by
            .iter()
            .map(|c| render_column_ref(c, dialect))
            .collect::<Result<_, _>>()?;
        sql.push_str(&format!(" PARTITION BY {}", cols.join(", ")));
    }

    // INTERVAL(...) [SLIDING(...)] [FILL(...)] — FILL is INSIDE the INTERVAL
    // clause, after SLIDING.
    if let Some(interval) = &desc.interval {
        sql.push(' ');
        sql.push_str(&render_interval(interval)?);
        if let Some(sliding) = &desc.sliding {
            // Only the token shape is validated here; TDengine authoritatively
            // enforces the cross-unit `SLIDING <= INTERVAL` magnitude rule.
            validate_duration(sliding, "SLIDING")?;
            sql.push_str(&format!(" SLIDING({})", sliding));
        }
        if let Some(fill) = &desc.fill {
            sql.push(' ');
            sql.push_str(&render_fill(fill)?);
        }
    }

    // ORDER BY
    if !desc.order_by.is_empty() {
        sql.push(' ');
        sql.push_str(&render_order_by(&desc.order_by, dialect)?);
    }

    // LIMIT [OFFSET]
    if let Some(limit) = desc.limit {
        sql.push_str(&format!(" LIMIT {}", limit));
        if let Some(offset) = desc.offset {
            sql.push_str(&format!(" OFFSET {}", offset));
        }
    }

    Ok(CompileResult { sql, params })
}

/// Render one WHERE / IN value: an inline SQL literal (`literal`) through the
/// shared `render_literal` injection seam, or a `?` placeholder that pushes the
/// value onto `params`. Mirrors `dml::render_value`.
fn render_where_value(
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

/// Render a bare column reference: verbatim for `*` and pseudo-columns, else a
/// backtick-quoted identifier (the injection seam). Used by the SELECT list,
/// PARTITION BY, and ORDER BY.
fn render_column_ref(name: &str, dialect: Dialect) -> Result<String, String> {
    if name == "*" || PSEUDO_COLUMNS.contains(&name) {
        Ok(name.to_string())
    } else {
        dialect.quote_ident(name)
    }
}

fn render_select_item(item: &SelectItem, dialect: Dialect) -> Result<String, String> {
    match item {
        SelectItem::Column(name) => render_column_ref(name, dialect),
        SelectItem::Expr(expr) => render_select_expr(expr, dialect),
    }
}

fn render_select_expr(expr: &SelectExpr, dialect: Dialect) -> Result<String, String> {
    let base = match (&expr.function, &expr.pseudo) {
        (Some(_), Some(_)) => {
            return Err(
                "E_EON_INVALID_SELECT: a select item is either a function or a pseudo-column, not both"
                    .into(),
            );
        }
        (Some(func), None) => {
            let lower = func.to_ascii_lowercase();
            if !SELECT_FUNCTIONS.contains(&lower.as_str()) {
                return Err(format!(
                    "E_EON_INVALID_SELECT_FUNCTION: unknown function '{}' (allowed: {})",
                    func,
                    SELECT_FUNCTIONS.join(", ")
                ));
            }
            let arg = expr.column.as_deref().ok_or_else(|| {
                format!(
                    "E_EON_INVALID_SELECT: function '{}' requires a column argument",
                    func
                )
            })?;
            // Only COUNT accepts the `*` wildcard in TDengine; `AVG(*)`, `SUM(*)`,
            // … are a syntax error. Reject early with a clear message instead of
            // emitting SQL the DB will bounce.
            if arg == "*" && lower != "count" {
                return Err(format!(
                    "E_EON_INVALID_SELECT: function '{}' does not accept '*' (only COUNT(*) is valid)",
                    func
                ));
            }
            format!("{}({})", lower.to_ascii_uppercase(), render_column_ref(arg, dialect)?)
        }
        (None, Some(pseudo)) => {
            if !PSEUDO_COLUMNS.contains(&pseudo.as_str()) {
                return Err(format!(
                    "E_EON_INVALID_PSEUDO_COLUMN: '{}' is not a recognised pseudo-column (allowed: {})",
                    pseudo,
                    PSEUDO_COLUMNS.join(", ")
                ));
            }
            // A pseudo-column select carries no column argument; `{ pseudo, column }`
            // is contradictory and previously dropped `column` silently (projecting
            // the wrong thing). Reject it, mirroring the function+pseudo guard above.
            if expr.column.is_some() {
                return Err(
                    "E_EON_INVALID_SELECT: a select item is either a pseudo-column or a bare column, not both"
                        .into(),
                );
            }
            pseudo.clone()
        }
        (None, None) => {
            // A structured item with neither function nor pseudo: an aliased bare
            // column projection (`{ column, alias }`).
            let col = expr.column.as_deref().ok_or_else(|| {
                "E_EON_INVALID_SELECT: select expression needs a function, pseudo, or column"
                    .to_string()
            })?;
            render_column_ref(col, dialect)?
        }
    };
    match &expr.alias {
        Some(alias) => Ok(format!("{} AS {}", base, dialect.quote_ident(alias)?)),
        None => Ok(base),
    }
}

fn render_interval(interval: &Interval) -> Result<String, String> {
    match interval {
        Interval::Simple(value) => {
            validate_duration(value, "INTERVAL")?;
            Ok(format!("INTERVAL({})", value))
        }
        Interval::WithOffset { value, offset } => {
            validate_duration(value, "INTERVAL")?;
            match offset {
                Some(off) => {
                    validate_duration(off, "INTERVAL offset")?;
                    Ok(format!("INTERVAL({}, {})", value, off))
                }
                None => Ok(format!("INTERVAL({})", value)),
            }
        }
    }
}

fn render_fill(fill: &Fill) -> Result<String, String> {
    let mode = fill.mode.to_ascii_uppercase();
    // `NEAR` is INTERP-only; reject explicitly with a pointed message.
    if mode == "NEAR" {
        return Err(
            "E_EON_INVALID_FILL: FILL(NEAR) is INTERP-only and not supported by the window builder"
                .into(),
        );
    }
    if !FILL_MODES.contains(&mode.as_str()) {
        return Err(format!(
            "E_EON_INVALID_FILL: unknown FILL mode '{}' (allowed: {})",
            fill.mode,
            FILL_MODES.join(", ")
        ));
    }
    if mode == "VALUE" {
        if fill.values.is_empty() {
            return Err(
                "E_EON_INVALID_FILL: FILL(VALUE, …) requires at least one fill constant".into(),
            );
        }
        let lits: Vec<String> = fill
            .values
            .iter()
            .map(render_literal)
            .collect::<Result<_, _>>()?;
        Ok(format!("FILL(VALUE, {})", lits.join(", ")))
    } else {
        if !fill.values.is_empty() {
            return Err(format!(
                "E_EON_INVALID_FILL: FILL({}) takes no values; only FILL(VALUE, …) carries constants",
                mode
            ));
        }
        Ok(format!("FILL({})", mode))
    }
}

fn render_order_by(items: &[OrderBy], dialect: Dialect) -> Result<String, String> {
    let parts: Vec<String> = items
        .iter()
        .map(|o| {
            let dir = match o.direction.to_ascii_lowercase().as_str() {
                "asc" => "ASC",
                "desc" => "DESC",
                other => {
                    return Err(format!(
                        "E_EON_INVALID_ORDER_DIRECTION: ORDER BY direction must be 'asc' or 'desc', got '{}'",
                        other
                    ));
                }
            };
            Ok(format!("{} {}", render_column_ref(&o.column, dialect)?, dir))
        })
        .collect::<Result<_, _>>()?;
    Ok(format!("ORDER BY {}", parts.join(", ")))
}

/// Parse a TDengine duration token into `(value, unit)`: a positive integer
/// followed by ONE unit letter. `b` = nanoseconds, `n` = MONTHS (the two
/// easily-confused units). Char-boundary-safe: the trailing unit is taken by
/// char, never a byte split. Shared by the SELECT window validators (58.5) AND
/// the database/STABLE `KEEP`/`DURATION` DDL validators (58.6) — the ONE place a
/// duration string is validated (memory `feedback_security_first`).
pub(crate) fn parse_duration(token: &str, what: &str) -> Result<(u64, char), String> {
    let err = || {
        format!(
            "E_EON_INVALID_DURATION: {} '{}' must be a positive integer followed by one unit (b=ns, u=µs, a=ms, s, m=min, h, d, w, n=months, y)",
            what, token
        )
    };
    let last = token.chars().last().ok_or_else(err)?;
    if !matches!(last, 'b' | 'u' | 'a' | 's' | 'm' | 'h' | 'd' | 'w' | 'n' | 'y') {
        return Err(err());
    }
    let num = &token[..token.len() - last.len_utf8()];
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return Err(err());
    }
    // A leading-zero or overlong token that overflows u64 is not a real
    // duration — reject it as invalid rather than saturating silently.
    if num.len() > 1 && num.starts_with('0') {
        return Err(err());
    }
    let value: u64 = num.parse().map_err(|_| err())?;
    if value == 0 {
        return Err(err());
    }
    Ok((value, last))
}

/// Validate a TDengine duration token (format only — discards the parsed value).
pub(crate) fn validate_duration(token: &str, what: &str) -> Result<(), String> {
    parse_duration(token, what).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn desc(json_str: &str) -> QueryDescription {
        serde_json::from_str(json_str).unwrap()
    }

    // ─── 58.1 baseline (placeholder mode) — must stay byte-identical ───

    #[test]
    fn basic_select_where_limit_is_byte_exact() {
        let d = desc(
            r#"{"table":"meters","select":["ts","current"],"wheres":[{"column":"groupid","operator":"=","value":2}],"limit":10}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT `ts`, `current` FROM `meters` WHERE `groupid` = ? LIMIT 10");
        assert_eq!(r.params, vec![json!(2)]);
    }

    #[test]
    fn select_defaults_to_star() {
        let d = desc(r#"{"table":"meters"}"#);
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT * FROM `meters`");
        assert!(r.params.is_empty());
    }

    #[test]
    fn multiple_wheres_and_or() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[
                {"column":"groupid","operator":"=","value":1},
                {"column":"current","operator":">","value":10,"type":"and"},
                {"column":"phase","operator":"IS NOT NULL","value":null,"type":"or"}
            ]}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "SELECT `ts` FROM `meters` WHERE `groupid` = ? AND `current` > ? OR `phase` IS NOT NULL"
        );
        assert_eq!(r.params, vec![json!(1), json!(10)]);
    }

    #[test]
    fn where_in_expands_placeholders() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"groupid","operator":"IN","value":[1,2,3]}]}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT `ts` FROM `meters` WHERE `groupid` IN (?, ?, ?)");
        assert_eq!(r.params, vec![json!(1), json!(2), json!(3)]);
    }

    #[test]
    fn empty_select_array_falls_back_to_star() {
        let d = desc(r#"{"table":"meters","select":[]}"#);
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT * FROM `meters`");
        assert!(r.params.is_empty());
    }

    #[test]
    fn scalar_operator_rejects_non_scalar_value() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"groupid","operator":"=","value":[1,2]}]}"#,
        );
        let err = compile_select(&d, Dialect::Tdengine).unwrap_err();
        assert!(err.contains("E_INVALID_WHERE_VALUE"), "got: {}", err);
    }

    #[test]
    fn scalar_operator_rejects_null_value() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"phase","operator":"=","value":null}]}"#,
        );
        let err = compile_select(&d, Dialect::Tdengine).unwrap_err();
        assert!(err.contains("E_INVALID_WHERE_VALUE"), "got: {}", err);
        assert!(err.contains("IS NULL"), "got: {}", err);
    }

    #[test]
    fn unknown_clause_type_is_rejected_not_coerced() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[
                {"column":"a","operator":"=","value":1},
                {"column":"b","operator":"=","value":2,"type":"xor"}
            ]}"#,
        );
        let err = compile_select(&d, Dialect::Tdengine).unwrap_err();
        assert!(err.contains("E_INVALID_CLAUSE_TYPE"), "got: {}", err);
    }

    #[test]
    fn injection_in_column_is_rejected() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"g; DROP TABLE meters","operator":"=","value":1}]}"#,
        );
        assert!(compile_select(&d, Dialect::Tdengine).is_err());
    }

    #[test]
    fn injection_in_table_is_rejected() {
        let d = desc(r#"{"table":"meters`; DROP TABLE x","select":["ts"]}"#);
        assert!(compile_select(&d, Dialect::Tdengine).is_err());
    }

    // ─── 58.5 literal-render mode (AC7) ───

    #[test]
    fn literal_where_inlines_values_with_no_params() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"groupid","operator":"=","value":2}],"limit":10,"literal":true}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT `ts` FROM `meters` WHERE `groupid` = 2 LIMIT 10");
        assert!(r.params.is_empty());
    }

    #[test]
    fn literal_where_escapes_injection_string_not_interpolated() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"location","operator":"=","value":"o'; DROP"}],"literal":true}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT `ts` FROM `meters` WHERE `location` = 'o\\'; DROP'");
        assert!(r.params.is_empty());
    }

    #[test]
    fn literal_where_in_list_inlines_literals() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"groupid","operator":"IN","value":[1,2,3]}],"literal":true}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(r.sql, "SELECT `ts` FROM `meters` WHERE `groupid` IN (1, 2, 3)");
        assert!(r.params.is_empty());
    }

    // ─── INTERVAL / SLIDING / FILL / PARTITION BY (AC1–AC4) ───

    #[test]
    fn interval_simple_and_with_offset() {
        let d = desc(r#"{"table":"meters","select":["_wstart"],"interval":"1m"}"#);
        assert_eq!(
            compile_select(&d, Dialect::Tdengine).unwrap().sql,
            "SELECT _wstart FROM `meters` INTERVAL(1m)"
        );
        let d2 = desc(
            r#"{"table":"meters","select":["_wstart"],"interval":{"value":"1m","offset":"10s"}}"#,
        );
        assert_eq!(
            compile_select(&d2, Dialect::Tdengine).unwrap().sql,
            "SELECT _wstart FROM `meters` INTERVAL(1m, 10s)"
        );
    }

    #[test]
    fn duration_rejects_leading_zero() {
        // A leading zero (`030d`, `00s`) is malformed — the sole duration
        // validator must reject it, matching its own doc contract.
        assert!(parse_duration("030d", "KEEP")
            .unwrap_err()
            .contains("E_EON_INVALID_DURATION"));
        assert!(parse_duration("00s", "KEEP").is_err());
        assert_eq!(parse_duration("30d", "KEEP").unwrap(), (30, 'd'));
    }

    #[test]
    fn interval_rejects_bad_duration_and_accepts_months() {
        let bad = desc(r#"{"table":"meters","interval":"1z"}"#);
        assert!(compile_select(&bad, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_DURATION"));
        let zero = desc(r#"{"table":"meters","interval":"0s"}"#);
        assert!(compile_select(&zero, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_DURATION"));
        // `n` is MONTHS, and is accepted.
        let months = desc(r#"{"table":"meters","select":["_wstart"],"interval":"3n"}"#);
        assert_eq!(
            compile_select(&months, Dialect::Tdengine).unwrap().sql,
            "SELECT _wstart FROM `meters` INTERVAL(3n)"
        );
    }

    #[test]
    fn sliding_requires_interval() {
        let d = desc(r#"{"table":"meters","select":["ts"],"sliding":"30s"}"#);
        assert!(compile_select(&d, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_SLIDING_REQUIRES_INTERVAL"));
    }

    #[test]
    fn fill_requires_interval() {
        let d = desc(r#"{"table":"meters","select":["ts"],"fill":{"mode":"prev"}}"#);
        assert!(compile_select(&d, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_FILL_REQUIRES_INTERVAL"));
    }

    #[test]
    fn fill_modes_render_and_value_carries_literals() {
        let prev = desc(r#"{"table":"m","select":["_wstart"],"interval":"1m","fill":{"mode":"prev"}}"#);
        assert_eq!(
            compile_select(&prev, Dialect::Tdengine).unwrap().sql,
            "SELECT _wstart FROM `m` INTERVAL(1m) FILL(PREV)"
        );
        let value = desc(
            r#"{"table":"m","select":["_wstart"],"interval":"1m","fill":{"mode":"value","values":[0,3.5]}}"#,
        );
        assert_eq!(
            compile_select(&value, Dialect::Tdengine).unwrap().sql,
            "SELECT _wstart FROM `m` INTERVAL(1m) FILL(VALUE, 0, 3.5)"
        );
    }

    #[test]
    fn fill_rejects_near_and_unknown_and_valueless_value() {
        let near = desc(r#"{"table":"m","interval":"1m","fill":{"mode":"near"}}"#);
        assert!(compile_select(&near, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_FILL"));
        let unknown = desc(r#"{"table":"m","interval":"1m","fill":{"mode":"bogus"}}"#);
        assert!(compile_select(&unknown, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_FILL"));
        let empty_value = desc(r#"{"table":"m","interval":"1m","fill":{"mode":"value"}}"#);
        assert!(compile_select(&empty_value, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_FILL"));
    }

    #[test]
    fn partition_by_quotes_tags_and_passes_pseudo_verbatim() {
        let d = desc(r#"{"table":"meters","select":["_wstart"],"partitionBy":["tbname","groupid"],"interval":"1m"}"#);
        assert_eq!(
            compile_select(&d, Dialect::Tdengine).unwrap().sql,
            "SELECT _wstart FROM `meters` PARTITION BY tbname, `groupid` INTERVAL(1m)"
        );
    }

    // ─── SELECT-list functions + pseudo-columns + alias (AC5) ───

    #[test]
    fn select_functions_pseudo_and_alias() {
        let d = desc(
            r#"{"table":"meters","select":[
                "tbname",
                {"pseudo":"_wstart"},
                {"function":"last_row","column":"current"},
                {"function":"avg","column":"voltage","alias":"avg_v"},
                {"function":"count","column":"*"}
            ]}"#,
        );
        assert_eq!(
            compile_select(&d, Dialect::Tdengine).unwrap().sql,
            "SELECT tbname, _wstart, LAST_ROW(`current`), AVG(`voltage`) AS `avg_v`, COUNT(*) FROM `meters`"
        );
    }

    #[test]
    fn select_rejects_unknown_function_and_pseudo() {
        let bad_fn = desc(r#"{"table":"m","select":[{"function":"evil","column":"x"}]}"#);
        assert!(compile_select(&bad_fn, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_SELECT_FUNCTION"));
        let bad_pseudo = desc(r#"{"table":"m","select":[{"pseudo":"_whatever"}]}"#);
        assert!(compile_select(&bad_pseudo, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_PSEUDO_COLUMN"));
        let bad_arg = desc(r#"{"table":"m","select":[{"function":"avg","column":"v; DROP"}]}"#);
        assert!(compile_select(&bad_arg, Dialect::Tdengine).is_err());
    }

    // ─── ORDER BY / OFFSET (AC6) ───

    #[test]
    fn order_by_and_offset() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"orderBy":[{"column":"ts","direction":"desc"}],"limit":10,"offset":5}"#,
        );
        assert_eq!(
            compile_select(&d, Dialect::Tdengine).unwrap().sql,
            "SELECT `ts` FROM `meters` ORDER BY `ts` DESC LIMIT 10 OFFSET 5"
        );
    }

    #[test]
    fn order_by_rejects_bad_direction() {
        let d = desc(r#"{"table":"m","orderBy":[{"column":"ts","direction":"sideways"}]}"#);
        assert!(compile_select(&d, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_ORDER_DIRECTION"));
    }

    #[test]
    fn offset_requires_limit() {
        let d = desc(r#"{"table":"m","select":["ts"],"offset":5}"#);
        assert!(compile_select(&d, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_OFFSET_REQUIRES_LIMIT"));
    }

    // ─── The full windowed query, byte-exact, canonical clause order (AC6) ───

    #[test]
    fn full_windowed_query_is_byte_exact() {
        let d = desc(
            r#"{
                "table":"meters",
                "select":["tbname","_wstart",{"function":"avg","column":"voltage"}],
                "wheres":[{"column":"ts","operator":">","value":1700000000000}],
                "partitionBy":["tbname"],
                "interval":"1m","sliding":"30s","fill":{"mode":"prev"},
                "orderBy":[{"column":"_wstart","direction":"asc"}],
                "limit":100,
                "literal":true
            }"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert_eq!(
            r.sql,
            "SELECT tbname, _wstart, AVG(`voltage`) FROM `meters` WHERE `ts` > 1700000000000 PARTITION BY tbname INTERVAL(1m) SLIDING(30s) FILL(PREV) ORDER BY _wstart ASC LIMIT 100"
        );
        assert!(r.params.is_empty());
    }

    #[test]
    fn where_on_tbname_pseudo_column_is_passed_verbatim() {
        let d = desc(
            r#"{"table":"meters","select":["ts"],"wheres":[{"column":"tbname","operator":"=","value":"d0"}],"literal":true}"#,
        );
        let r = compile_select(&d, Dialect::Tdengine).unwrap();
        assert!(
            r.sql.contains("WHERE tbname = 'd0'"),
            "tbname must not be backtick-quoted in WHERE: {}",
            r.sql
        );
    }

    #[test]
    fn select_expr_rejects_unknown_field() {
        // A misspelled `function` key must fail loud, not silently degrade to a
        // bare column (deny_unknown_fields on SelectExpr).
        let parsed: Result<QueryDescription, _> = serde_json::from_str(
            r#"{"table":"meters","select":[{"functon":"avg","column":"voltage"}]}"#,
        );
        assert!(parsed.is_err());
    }

    #[test]
    fn select_pseudo_with_column_is_rejected() {
        // `{ pseudo, column }` is contradictory — it must not silently drop the
        // column and project the pseudo (which projected the wrong thing before).
        let d = desc(r#"{"table":"m","select":[{"pseudo":"_wstart","column":"voltage"}]}"#);
        assert!(compile_select(&d, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_SELECT"));
    }

    #[test]
    fn aggregate_star_argument_is_rejected_except_count() {
        // Only COUNT(*) is legal in TDengine; AVG(*)/SUM(*) must fail loud here.
        let bad = desc(r#"{"table":"m","select":[{"function":"avg","column":"*"}]}"#);
        assert!(compile_select(&bad, Dialect::Tdengine)
            .unwrap_err()
            .contains("E_EON_INVALID_SELECT"));
        // COUNT(*) stays valid.
        let ok = desc(r#"{"table":"m","select":[{"function":"count","column":"*"}]}"#);
        assert_eq!(
            compile_select(&ok, Dialect::Tdengine).unwrap().sql,
            "SELECT COUNT(*) FROM `m`"
        );
    }
}
