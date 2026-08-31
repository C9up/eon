//! WHERE-operator allowlist.
//!
//! Identifier quoting lives on `Dialect::quote_ident` (dialect.rs) — the
//! backtick-quoting injection seam. This module guards the *operator* seam,
//! ported in spirit from atlas `identifier.rs`.

/// Validate a WHERE operator against an allowlist. Only the operators the
/// 58.1 SELECT builder actually emits are accepted — anything else is a typed
/// error, never interpolated into SQL.
pub fn validate_operator(op: &str) -> Result<&str, String> {
    match op {
        "=" | "!=" | "<>" | ">" | ">=" | "<" | "<=" | "LIKE" | "NOT LIKE" | "IN" | "NOT IN"
        | "IS NULL" | "IS NOT NULL" => Ok(op),
        _ => Err(format!("E_UNSAFE_OPERATOR: invalid operator: '{}'", op)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_operator_allows_known_and_rejects_rest() {
        assert!(validate_operator("=").is_ok());
        assert!(validate_operator(">=").is_ok());
        assert!(validate_operator("IN").is_ok());
        assert!(validate_operator("IS NOT NULL").is_ok());
        assert!(validate_operator("= 1; DROP TABLE--").is_err());
        assert!(validate_operator("GLOB").is_err());
    }
}
