//! NAPI bindings for eon-query — exposes the TDengine SQL compiler to TypeScript.
//!
//! Panic-safety is an architecture invariant: every entry point is wrapped in
//! `catch_unwind` so a Rust panic becomes a `napi::Error`, never a Node crash.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::catch_unwind;

/// Compile a tagged JSON statement spec (`{ kind: "insert" | "select", ... }`)
/// into a JSON-encoded `CompiledStatement` (`{ statements: [...], params: [...] }`).
/// `dialect` is `"tdengine"`.
#[napi]
pub fn compile_statement(spec_json: String, dialect: String) -> Result<String> {
    let result = catch_unwind(|| {
        let dialect = eon_query::Dialect::from_name(&dialect)?;
        let spec: eon_query::StatementSpec = serde_json::from_str(&spec_json)
            .map_err(|e| format!("Invalid statement spec: {}", e))?;
        let compiled = eon_query::compile_statement(&spec, dialect)?;
        serde_json::to_string(&compiled).map_err(|e| format!("Serialization error: {}", e))
    });

    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(_) => Err(Error::from_reason("Internal panic in statement compiler")),
    }
}

/// Validate and backtick-quote a TDengine identifier.
#[napi]
pub fn quote_ident(name: String) -> Result<String> {
    let result = catch_unwind(|| eon_query::Dialect::Tdengine.quote_ident(&name));

    match result {
        Ok(Ok(quoted)) => Ok(quoted),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(_) => Err(Error::from_reason("Internal panic in identifier quoter")),
    }
}
