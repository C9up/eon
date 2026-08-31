//! TDengine SQL dialect: identifier quoting + placeholder + column type mapping.
//!
//! A single-variant seam (AD10) — TDengine is the only backend today, but the
//! rest of the compiler stays dialect-agnostic so a future TSDB could slot in
//! without rewriting the SQL builders. We ship one; we do NOT port atlas's
//! Sqlite/Postgres/Mysql matrix.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    #[default]
    Tdengine,
}

impl Dialect {
    pub fn from_name(name: &str) -> Result<Self, String> {
        match name.to_lowercase().as_str() {
            "tdengine" | "taos" => Ok(Dialect::Tdengine),
            _ => Err(format!("unknown dialect: {}", name)),
        }
    }

    /// Quote character for identifiers — backtick for TDengine.
    pub fn quote_char(&self) -> char {
        match self {
            Dialect::Tdengine => '`',
        }
    }

    /// Parameter placeholder. TDengine STMT binding uses positional `?`
    /// (NOT `$N`) — the index is irrelevant to the emitted token but kept in the
    /// signature to mirror the atlas dialect seam.
    pub fn placeholder(&self, _index: u32) -> String {
        match self {
            Dialect::Tdengine => "?".into(),
        }
    }

    /// Validate and quote an identifier. Supports one level of qualification
    /// (`db.table`, ≤2 dot segments). Rejects any name containing the quote
    /// character, NUL, or a char outside `[A-Za-z0-9_]` with a typed
    /// `E_UNSAFE_IDENTIFIER` error — never a panic, never emitted SQL. This is
    /// the injection seam; ported in spirit from atlas `Dialect::quote_ident`.
    pub fn quote_ident(&self, name: &str) -> Result<String, String> {
        if name == "*" {
            return Ok(name.to_string());
        }
        let q = self.quote_char();
        let parts: Vec<&str> = name.splitn(3, '.').collect();
        if parts.len() > 2 {
            return Err(format!(
                "E_UNSAFE_IDENTIFIER: too many dot segments in identifier: '{}'",
                name
            ));
        }
        for part in &parts {
            if part.is_empty() {
                return Err(format!(
                    "E_UNSAFE_IDENTIFIER: empty segment in identifier: '{}'",
                    name
                ));
            }
            if part.contains('\0') || part.contains(q) {
                return Err(format!(
                    "E_UNSAFE_IDENTIFIER: identifier contains an illegal character (backtick or NUL): '{}'",
                    name
                ));
            }
            if !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(format!(
                    "E_UNSAFE_IDENTIFIER: invalid identifier '{}' — only letters, digits, and underscores are allowed",
                    name
                ));
            }
        }
        Ok(parts
            .iter()
            .map(|p| format!("{}{}{}", q, p, q))
            .collect::<Vec<_>>()
            .join("."))
    }

    /// Map a logical column/tag type to its TDengine physical type.
    ///
    /// The length-bearing types enforce their argument here (this is where the
    /// DDL compiler learns a `VARCHAR`/`NCHAR`/`VARBINARY` is missing its `(n)`
    /// or a `DECIMAL` its precision) — a typed `E_LENGTH_REQUIRED` error, never
    /// a silently-defaulted width. No cast machinery (D7): TDengine's STMT path
    /// binds typed columns directly.
    pub fn map_column_type(&self, spec: &ColumnTypeSpec) -> Result<String, String> {
        use ColumnTypeKind::*;
        match spec.kind {
            Timestamp => Ok("TIMESTAMP".into()),
            Int => Ok("INT".into()),
            BigInt => Ok("BIGINT".into()),
            SmallInt => Ok("SMALLINT".into()),
            TinyInt => Ok("TINYINT".into()),
            Float => Ok("FLOAT".into()),
            Double => Ok("DOUBLE".into()),
            Bool => Ok("BOOL".into()),
            Varchar => Ok(format!("VARCHAR({})", require_length(spec, "VARCHAR")?)),
            Nchar => Ok(format!("NCHAR({})", require_length(spec, "NCHAR")?)),
            Varbinary => Ok(format!("VARBINARY({})", require_length(spec, "VARBINARY")?)),
            Json => Ok("JSON".into()),
            Decimal => {
                let precision = spec.precision.ok_or_else(|| {
                    "E_LENGTH_REQUIRED: DECIMAL requires a precision — DECIMAL(p[, s])".to_string()
                })?;
                if precision == 0 {
                    return Err(
                        "E_LENGTH_REQUIRED: DECIMAL precision must be > 0 — DECIMAL(0)".to_string(),
                    );
                }
                match spec.scale {
                    Some(scale) => Ok(format!("DECIMAL({}, {})", precision, scale)),
                    None => Ok(format!("DECIMAL({})", precision)),
                }
            }
        }
    }
}

/// A length-bearing TDengine type (`VARCHAR`/`NCHAR`/`VARBINARY`) with no `(n)`
/// is an error, not a silent default — TDengine rejects the unbounded form.
fn require_length(spec: &ColumnTypeSpec, ty: &str) -> Result<u32, String> {
    let n = spec
        .length
        .ok_or_else(|| format!("E_LENGTH_REQUIRED: {} requires a length — {}(n)", ty, ty))?;
    if n == 0 {
        return Err(format!(
            "E_LENGTH_REQUIRED: {} length must be > 0 — {}(0)",
            ty, ty
        ));
    }
    Ok(n)
}

/// Logical column/tag type kinds mappable to TDengine physical types.
/// Consumed by story 58.3's DDL compiler; declared here as the type seam.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColumnTypeKind {
    Timestamp,
    Int,
    BigInt,
    SmallInt,
    TinyInt,
    Float,
    Double,
    Bool,
    Varchar,
    Nchar,
    Varbinary,
    Decimal,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnTypeSpec {
    pub kind: ColumnTypeKind,
    #[serde(default)]
    pub length: Option<u32>,
    #[serde(default)]
    pub precision: Option<u32>,
    #[serde(default)]
    pub scale: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_name_works() {
        assert_eq!(Dialect::from_name("tdengine").unwrap(), Dialect::Tdengine);
        assert_eq!(Dialect::from_name("TAOS").unwrap(), Dialect::Tdengine);
        assert!(Dialect::from_name("postgres").is_err());
    }

    #[test]
    fn quoting_uses_backticks() {
        assert_eq!(Dialect::Tdengine.quote_ident("meters").unwrap(), "`meters`");
        assert_eq!(
            Dialect::Tdengine.quote_ident("db.meters").unwrap(),
            "`db`.`meters`"
        );
        assert_eq!(Dialect::Tdengine.quote_ident("*").unwrap(), "*");
    }

    #[test]
    fn placeholder_is_question_mark() {
        assert_eq!(Dialect::Tdengine.placeholder(1), "?");
        assert_eq!(Dialect::Tdengine.placeholder(42), "?");
    }

    #[test]
    fn quoting_rejects_injection() {
        assert!(Dialect::Tdengine.quote_ident("id`; DROP").is_err());
        assert!(Dialect::Tdengine
            .quote_ident("id; DROP TABLE meters")
            .is_err());
        assert!(Dialect::Tdengine.quote_ident("id\0").is_err());
        assert!(Dialect::Tdengine.quote_ident("a.b.c").is_err()); // too many segments
        assert!(Dialect::Tdengine.quote_ident(".leading").is_err()); // empty segment
    }

    #[test]
    fn type_map_covers_tdengine_physicals() {
        let ts = ColumnTypeSpec {
            kind: ColumnTypeKind::Timestamp,
            length: None,
            precision: None,
            scale: None,
        };
        assert_eq!(Dialect::Tdengine.map_column_type(&ts).unwrap(), "TIMESTAMP");
        let vc = ColumnTypeSpec {
            kind: ColumnTypeKind::Varchar,
            length: Some(32),
            precision: None,
            scale: None,
        };
        assert_eq!(
            Dialect::Tdengine.map_column_type(&vc).unwrap(),
            "VARCHAR(32)"
        );
        let nc = ColumnTypeSpec {
            kind: ColumnTypeKind::Nchar,
            length: Some(24),
            precision: None,
            scale: None,
        };
        assert_eq!(Dialect::Tdengine.map_column_type(&nc).unwrap(), "NCHAR(24)");
        let dec = ColumnTypeSpec {
            kind: ColumnTypeKind::Decimal,
            length: None,
            precision: Some(12),
            scale: Some(4),
        };
        assert_eq!(
            Dialect::Tdengine.map_column_type(&dec).unwrap(),
            "DECIMAL(12, 4)"
        );
        let small = ColumnTypeSpec {
            kind: ColumnTypeKind::SmallInt,
            length: None,
            precision: None,
            scale: None,
        };
        assert_eq!(
            Dialect::Tdengine.map_column_type(&small).unwrap(),
            "SMALLINT"
        );
    }

    #[test]
    fn type_map_requires_length_and_precision() {
        let vc = ColumnTypeSpec {
            kind: ColumnTypeKind::Varchar,
            length: None,
            precision: None,
            scale: None,
        };
        assert!(Dialect::Tdengine
            .map_column_type(&vc)
            .unwrap_err()
            .contains("E_LENGTH_REQUIRED"));
        let dec = ColumnTypeSpec {
            kind: ColumnTypeKind::Decimal,
            length: None,
            precision: None,
            scale: None,
        };
        assert!(Dialect::Tdengine
            .map_column_type(&dec)
            .unwrap_err()
            .contains("E_LENGTH_REQUIRED"));
    }

    #[test]
    fn type_map_rejects_zero_length_and_precision() {
        let vc = ColumnTypeSpec {
            kind: ColumnTypeKind::Varchar,
            length: Some(0),
            precision: None,
            scale: None,
        };
        assert!(Dialect::Tdengine
            .map_column_type(&vc)
            .unwrap_err()
            .contains("E_LENGTH_REQUIRED"));
        let nc = ColumnTypeSpec {
            kind: ColumnTypeKind::Nchar,
            length: Some(0),
            precision: None,
            scale: None,
        };
        assert!(Dialect::Tdengine
            .map_column_type(&nc)
            .unwrap_err()
            .contains("E_LENGTH_REQUIRED"));
        let dec = ColumnTypeSpec {
            kind: ColumnTypeKind::Decimal,
            length: None,
            precision: Some(0),
            scale: None,
        };
        assert!(Dialect::Tdengine
            .map_column_type(&dec)
            .unwrap_err()
            .contains("E_LENGTH_REQUIRED"));
    }
}
