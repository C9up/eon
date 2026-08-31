//! SQL value-literal rendering — the ONE place a JSON value becomes an inlined
//! TDengine SQL literal.
//!
//! This is a security boundary shared by every literal-emitting compiler
//! (child-table DDL `literal: true`, story 58.3; the literal INSERT path, story
//! 58.4). Strings are single-quoted with `\\` and `'` backslash-escaped
//! (TDengine escape rules, context7 `/taosdata/tdengine` `90-escape.md`), a NUL
//! byte is rejected, and objects/arrays (a JSON tag) are serialised to a JSON
//! string and escaped through the same path. Numbers and booleans render
//! through their canonical, injection-free forms.
//!
//! Keeping this in one module (not duplicated per compiler) means the injection
//! seam is audited once (memory `feedback_security_first`).

use serde_json::Value;

/// Render a JSON value as a typed TDengine SQL literal.
pub(crate) fn render_literal(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("NULL".into()),
        Value::Bool(b) => Ok(if *b { "true".into() } else { "false".into() }),
        Value::Number(n) => Ok(n.to_string()),
        Value::String(s) => quote_string_literal(s),
        other => {
            let json = serde_json::to_string(other)
                .map_err(|e| format!("E_UNSAFE_LITERAL: could not serialise value: {}", e))?;
            quote_string_literal(&json)
        }
    }
}

/// Single-quote a string literal, backslash-escaping `\` and `'`, rejecting NUL.
///
/// DO NOT "fix" this to SQL-standard `''` quote-doubling: TDengine uses C-style
/// backslash escaping (context7 `/taosdata/tdengine` `90-escape.md`), so `'`
/// MUST be emitted as `\'`, not `''`. Escaping `\` BEFORE `'` is load-bearing —
/// it neutralises a trailing backslash (`abc\` → `'abc\\'`) so a value can never
/// break out of the quotes. Switching to `''` would reintroduce an injection.
pub(crate) fn quote_string_literal(s: &str) -> Result<String, String> {
    if s.contains('\0') {
        return Err("E_UNSAFE_LITERAL: string literal contains a NUL byte".into());
    }
    let escaped = s.replace('\\', "\\\\").replace('\'', "\\'");
    Ok(format!("'{}'", escaped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_primitives_injection_free() {
        assert_eq!(render_literal(&json!(1)).unwrap(), "1");
        assert_eq!(render_literal(&json!(10.3)).unwrap(), "10.3");
        assert_eq!(render_literal(&json!(true)).unwrap(), "true");
        assert_eq!(render_literal(&Value::Null).unwrap(), "NULL");
        assert_eq!(render_literal(&json!("CA")).unwrap(), "'CA'");
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        assert_eq!(
            render_literal(&json!("Cali'fornia")).unwrap(),
            "'Cali\\'fornia'"
        );
        assert_eq!(render_literal(&json!("a\\b")).unwrap(), "'a\\\\b'");
    }

    #[test]
    fn rejects_nul_byte() {
        assert!(render_literal(&json!("a\0b"))
            .unwrap_err()
            .contains("E_UNSAFE_LITERAL"));
    }

    #[test]
    fn serialises_json_values_through_the_string_path() {
        assert_eq!(render_literal(&json!({"k":1})).unwrap(), "'{\"k\":1}'");
    }
}
