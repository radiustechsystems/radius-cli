/**
 * Contract checks between the hand-written clients, the OpenAPI documents in specs/, and the
 * generated types: the generated files are fresh, every endpoint a client calls is in its spec
 * with the right method, the mock responses the unit tests use only carry documented fields, and
 * the error codes the clients special-case are ones the APIs document.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import openapiTS, { astToString } from 'openapi-typescript';
import { createFaucetClient } from '../src/faucet.js';
import { createSwapClient } from '../src/swap.js';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (rel: string) => JSON.parse(await readFile(path.join(root, rel), 'utf8')) as OpenApi;

interface OpenApi {
  info: { title: string; version: string };
  paths: Record<string, Record<string, { requestBody?: unknown; responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, Schema> };
}
interface Schema { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: string[]; $ref?: string; items?: Schema; oneOf?: Schema[]; anyOf?: Schema[]; nullable?: boolean }

const ACCOUNT = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);

/** Record every request a client makes as `METHOD /path` (query stripped, path params re-templated). */
function recorder(answer: (path: string) => unknown) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.pathname.replace(/0x[0-9a-fA-F]{40}/, '{address}')}`);
    return Response.json(answer(u.pathname));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const resolve = (spec: OpenApi, s: Schema): Schema => (s.$ref ? spec.components.schemas[s.$ref.split('/').pop()!] : s);

/** Assert `value` uses only properties the schema declares (recursively), and has every required one. */
function assertConforms(spec: OpenApi, schema: Schema, value: unknown, where: string) {
  const s = resolve(spec, schema);
  if (s.properties && typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(v)) expect(Object.keys(s.properties), `${where}.${key} is not in the spec`).toContain(key);
    for (const key of s.required ?? []) expect(v, `${where} is missing required ${key}`).toHaveProperty(key);
    for (const [key, sub] of Object.entries(s.properties)) if (v[key] !== undefined && v[key] !== null) assertConforms(spec, sub, v[key], `${where}.${key}`);
  } else if (s.items && Array.isArray(value)) {
    value.forEach((item, i) => assertConforms(spec, s.items!, item, `${where}[${i}]`));
  }
  if (s.enum && typeof value === 'string') expect(s.enum, `${where}=${value} is not in the spec enum`).toContain(value);
}

describe('generated types are current', () => {
  it.each(['faucet', 'swap'])('src/generated/%s.ts matches a fresh generation from specs/', async (name) => {
    const spec = await load(`specs/${name}.openapi.json`);
    const generated = await readFile(path.join(root, `src/generated/${name}.ts`), 'utf8');
    const fresh = astToString(await openapiTS(spec as never, { exportType: true, rootTypes: false }));
    expect(generated.endsWith(fresh), `run \`pnpm generate:api\` (${name})`).toBe(true);
    expect(generated.startsWith(`// Generated from specs/${name}.openapi.json`)).toBe(true);
  });
});

describe('faucet client vs specs/faucet.openapi.json', () => {
  it('only calls documented operations', async () => {
    const spec = await load('specs/faucet.openapi.json');
    const rec = recorder((p) => (p.endsWith('/drip') ? { success: true, address: ACCOUNT.address, token: 'SBC', amount: '0.5', tx_hash: '0x' + 'ab'.repeat(32) } : p.includes('/challenge/') ? { message: 'm', address: 'a', token: 'SBC', instructions: '' } : { address: 'a', token: 'SBC', rate_limited: false, retry_after_ms: null, remaining_requests: 1, drip_amount: '0.5', native_drip_amount: null }));
    const client = createFaucetClient({ url: 'https://faucet.test/api/v1/faucet', fetch: rec.fetch });
    await client.status(ACCOUNT.address);
    await client.challenge(ACCOUNT.address);
    await client.drip(ACCOUNT.address);
    await client.fund(ACCOUNT.address, { signer: ACCOUNT, signature: 'always' });
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    for (const call of rec.calls) expect(documented, call).toContain(call);
    expect(new Set(rec.calls).size).toBe(documented.length);   // and every documented operation is used
  });

  it('the unit-test fixtures and client-side codes agree with the spec', async () => {
    const spec = await load('specs/faucet.openapi.json');
    const schemas = spec.components.schemas;
    assertConforms(spec, schemas.StatusResponse, { address: 'a', token: 'SBC', rate_limited: false, retry_after_ms: null, remaining_requests: 60, drip_amount: '0.5', native_drip_amount: '0.001' }, 'StatusResponse');
    assertConforms(spec, schemas.DripSuccess, { success: true, address: 'a', token: 'SBC', amount: '0.5', tx_hash: '0x00', native: { token: 'RUSD', amount: '0.001', tx_hash: '0x01' }, next_drip_at: 1 }, 'DripSuccess');
    assertConforms(spec, schemas.ChallengeResponse, { message: 'm', address: 'a', token: 'SBC', instructions: 'i' }, 'ChallengeResponse');
    assertConforms(spec, schemas.FaucetErrorResponse, { error: { code: 'rate_limited', message: 'm', request_id: 'r', retry_after_ms: 1, details: { challenge: 'c' } } }, 'FaucetErrorResponse');
    // Codes the fund() flow branches on must be real.
    const codes = schemas.FaucetErrorResponse.properties!.error.properties!.code.enum!;
    for (const c of ['signature_required', 'invalid_signature', 'rate_limited']) expect(codes).toContain(c);
    // `token` defaults to SBC server-side, so only `address` is required; the client always sends both plus an optional signature.
    expect(Object.keys(schemas.DripRequest.properties!)).toEqual(expect.arrayContaining(['address', 'token', 'signature']));
    expect(schemas.DripRequest.required).toEqual(['address']);
  });
});

describe('swap client vs specs/swap.openapi.json', () => {
  const INSTRUCTIONS = {
    version: '1', environment: 'testnet', overview: 'o',
    supported_routes: [{ source_chain: 'base_sepolia', source_token: 'SBC', destination_chain: 'radius_testnet', destination_token: 'SBC', source_chain_id: 84532, source_token_contract: '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16', source_token_decimals: 6, destination_chain_id: 72344, destination_token_contract: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb', destination_token_decimals: 6 }],
    steps: [{ step: 1, name: 'n', description: 'd' }], important_rules: ['r'], error_codes: [{ code: 'RATE_LIMITED', description: 'd', caller_action: 'a' }],
  };
  const UNSIGNED = { to: '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16', data: '0xa9', value: '0x0', chainId: 84532, type: 'legacy', nonce: '0x7', gas: '0x186a0', gasPrice: '0x3b9aca00' };
  const PREPARED = { swap_token: 't', swap_token_expires_at: '2026-09-20T12:06:00Z', prepared_tx_expires_at: '2026-09-20T12:05:00Z', deposit_address: '0x3333333333333333333333333333333333333333', deposit_token_address: UNSIGNED.to, deposit_chain: 'base_sepolia', deposit_token: 'SBC', destination_chain: 'radius_testnet', destination_token: 'SBC', payout_token_address: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb', amount: '1', unsigned_tx: UNSIGNED };
  const BROADCAST = { session_id: 'sess_a1', swap_token: 't2', swap_token_expires_at: '2026-09-20T12:15:00Z', tx_hash: '0x' + 'ab'.repeat(32), status: 'pending_broadcast' };
  const STATUS = { kind: 'session', session_id: 'sess_a1', status: 'complete', source_chain: 'base_sepolia', source_token: 'SBC', source_address: ACCOUNT.address, destination_address: ACCOUNT.address, destination_chain: 'radius_testnet', destination_token: 'SBC', deposit_address: PREPARED.deposit_address, deposit_token_address: UNSIGNED.to, payout_token_address: PREPARED.payout_token_address, amount: '1', tx_hash: BROADCAST.tx_hash, payout_tx: '0x' + 'cd'.repeat(32), created_at: '2026-09-20T12:00:00Z', updated_at: '2026-09-20T12:01:00Z', completed_at: '2026-09-20T12:03:00Z', error: { code: 'SOURCE_PREFLIGHT_FAILED', message: 'm', request_id: 'r' } };

  it('only calls documented operations, and all of them', async () => {
    const spec = await load('specs/swap.openapi.json');
    const rec = recorder((p) => p.endsWith('/instructions') ? INSTRUCTIONS : p.endsWith('/prepare') ? PREPARED : p.endsWith('/broadcast') ? BROADCAST : p.endsWith('/status') ? STATUS : p.endsWith('/sessions/token') ? { swap_token: 't3', swap_token_expires_at: '2026-09-20T12:15:00Z' } : { items: [STATUS] });
    const client = createSwapClient({ url: 'https://swap.test/api/v1/swap', network: 'testnet', fetch: rec.fetch });
    await client.swap({ sourceChain: 'base_sepolia', sourceToken: 'SBC', destinationChain: 'radius_testnet', destinationToken: 'SBC', amount: '1' }, ACCOUNT);
    const t = await client.sessionListToken(ACCOUNT);
    await client.listSessions(t.swapToken, { status: 'prepared' });
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    for (const call of rec.calls) expect(documented, call).toContain(call);
    expect(new Set(rec.calls).size).toBe(documented.length);
  });

  it('the fixtures conform to the response schemas and the client-side codes are real', async () => {
    const spec = await load('specs/swap.openapi.json');
    const s = spec.components.schemas;
    assertConforms(spec, s.SwapInstructionsResponse, INSTRUCTIONS, 'SwapInstructionsResponse');
    assertConforms(spec, s.PrepareSwapIntentResponse, PREPARED, 'PrepareSwapIntentResponse');
    assertConforms(spec, s.BroadcastSwapTransactionResponse, BROADCAST, 'BroadcastSwapTransactionResponse');
    assertConforms(spec, s.SwapStatusResponse, STATUS, 'SwapStatusResponse');
    assertConforms(spec, s.SwapSessionListResponse, { items: [STATUS], next_cursor: 'c' }, 'SwapSessionListResponse');
    const codes = s.SwapErrorDetails.properties!.code.enum!;
    for (const c of ['RATE_LIMITED', 'NOT_FOUND', 'INTERNAL_ERROR', 'INVALID_REQUEST', 'INVALID_AMOUNT', 'UNSUPPORTED_ROUTE', 'INVALID_SIGNED_TX']) expect(codes).toContain(c);
    // The EIP-712 field lists the client signs are the ones the spec's instructions describe.
    const desc = (spec.paths['/api/v1/swap/prepare'].post as { description: string }).description;
    for (const f of ['sourceAddress', 'sourceChain', 'sourceToken', 'destinationChain', 'destinationToken', 'destinationAddress', 'amount', 'idempotencyKey', 'expiresAt', 'environment']) expect(desc).toContain(`{ name: '${f}'`);
    expect(desc).toContain("name: 'Radius Swap API'");
    expect(desc).toContain("version: '1'");
  });
});
