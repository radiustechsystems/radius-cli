/**
 * Helpers for reading the generated OpenAPI types in `src/generated/` (openapi-typescript output,
 * regenerated from `specs/*.openapi.json` by `pnpm generate:api`). The hand-written clients derive
 * their wire types from operations here, so a renamed path, field or enum member in a spec fails
 * `tsc` in the client that speaks it instead of surfacing at runtime.
 */

/** The `application/json` body of an operation's 200 response. */
export type JsonOk<Op> = Op extends { responses: { 200: { content: { 'application/json': infer T } } } } ? T : never;

/** The `application/json` request body of an operation. */
export type JsonBody<Op> = Op extends { requestBody?: infer B } ? (NonNullable<B> extends { content: { 'application/json': infer T } } ? T : never) : never;

/** The query parameters of an operation. */
export type Query<Op> = Op extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

/** The `error` object of a Radius API error envelope (`{ error: { code, message, request_id, retry_after_ms?, details? } }`). */
export type ErrorDetailsOf<Envelope> = Envelope extends { error: infer E } ? E : never;

/**
 * Compile-time assertion that the hand-written type `A` is assignable to the wire type `B`
 * (`type _ = AssertAssignable<Mine, Wire['Thing']>`). Narrower hand-written types (`0x${string}`
 * for addresses) stay assignable; a field the spec drops or renames does not.
 */
export type AssertAssignable<A extends B, B> = A;
