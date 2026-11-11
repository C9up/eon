/**
 * Set one decoded column on a row as an own data property.
 *
 * Column names come from the server, and any `[A-Za-z0-9_]` identifier is a
 * valid alias, `__proto__` and `constructor` included. Plain assignment onto
 * `{}` sends `__proto__` through the accessor `Object.prototype` inherits: a
 * primitive value vanishes from the row and an object value (VARBINARY decodes
 * to an `ArrayBuffer`) becomes the row's prototype. Defining the property
 * never consults the prototype chain.
 */
export function defineColumn(
	row: Record<string, unknown>,
	name: string,
	value: unknown,
): void {
	Object.defineProperty(row, name, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}
