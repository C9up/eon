// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

/**
 * Compile a tagged JSON statement spec (`{ kind: "insert" | "select", ... }`)
 * into a JSON-encoded `CompiledStatement` (`{ statements: [...], params: [...] }`).
 * `dialect` is `"tdengine"`.
 */

export declare function compileStatement(
	specJson: string,
	dialect: string,
): string;

/** Validate and backtick-quote a TDengine identifier. */

export declare function quoteIdent(name: string): string;
