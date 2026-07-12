/**
 * Super-table metadata Symbols.
 *
 * Extracted into their own module — mirroring atlas `metadata-keys.ts` — so the
 * decorator layer reads them without importing a base class, avoiding the
 * runtime cycle that a shared `BaseEntity` import would form (atlas fallow
 * 2026-06-14). Pure Symbols, zero runtime dependencies.
 */

/** The `{ name }` super-table descriptor (mirrors atlas `ENTITY_KEY`). */
export const SUPER_TABLE_KEY = Symbol("eon:superTable");

/** The ordered metric-column registry (`@Timestamp` + `@Column`). */
export const COLUMNS_KEY = Symbol("eon:columns");

/** The tag registry (`@Tag`) — separate from columns (no atlas analogue). */
export const TAGS_KEY = Symbol("eon:tags");

/** The property name of the mandatory first `TIMESTAMP` column (`@Timestamp`). */
export const TIMESTAMP_KEY = Symbol("eon:timestamp");
