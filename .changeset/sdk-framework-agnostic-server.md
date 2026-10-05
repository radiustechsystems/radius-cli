---
"radius-sdk": minor
---

Accept payments from any HTTP stack, not just Hono. New `radius-sdk/server` entry point:

- `radiusPayments()` is a web-standard handler (`Request` in, `Response` out) for Cloudflare Workers without a framework, Bun, Deno, Node 18+, and Next.js / SvelteKit / Remix route handlers. Paid handlers receive the settled receipt as a second argument.
- `createRadiusServer()` exposes the Radius x402 resource server and a `routes()` builder that plug straight into the upstream adapters: `paymentMiddleware(radius.routes({ … }), radius.server)` with `@x402/express`, `@x402/next` or `@x402/hono`.
- `onSettled` is registered on the resource server, so it fires whichever adapter served the request (it receives the x402 request context; `requestOf(context)` returns the `Request` for the SDK's own adapters). Errors thrown by `onSettled` are logged by x402 core instead of failing the request.
- `radius-sdk/hono` is now a thin wrapper over the web-standard handler with the same options; `RadiusHonoAdapter` is gone.
- `@x402/core` / `@x402/evm` bumped to 2.27.0 (the version line the upstream adapters require).
- New examples: `examples/worker-plain` (no framework) and `examples/express-seller` (`@x402/express`).
