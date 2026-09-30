import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Block runtime resolution, including transitive imports, so the workspace's
// installed viem cannot hide a regression in the seller dependency boundary.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (/^(viem|@x402\\/evm)(\\/|$)/.test(specifier)) {
    throw new Error('Buyer dependency imported: ' + specifier);
  }
  return nextResolve(specifier, context);
}
`;
const registration = `
import { register } from 'node:module';
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
`;

function run(source, blockBuyerDependencies = false) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    ...(blockBuyerDependencies ? ['--import', `data:text/javascript,${encodeURIComponent(registration)}`] : []),
    '--eval', source,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('root and Hono seller work with buyer dependency imports blocked', () => {
  run(`
    import assert from 'node:assert/strict';
    import { resolveNetwork } from 'radius-sdk';
    import { Hono } from 'hono';
    import { radiusPayments } from 'radius-sdk/hono';

    assert.equal(resolveNetwork('testnet').chain.id, 72344);
    const app = new Hono();
    let called = false;
    app.use('/paid', radiusPayments({
      network: 'testnet',
      payTo: '0x1111111111111111111111111111111111111111',
      routes: { 'GET /paid': '0.001 SBC' },
      facilitator: { live: false },
    }));
    app.get('/paid', (c) => { called = true; return c.text('paid'); });
    const response = await app.request('http://localhost/paid');
    assert.equal(response.status, 402);
    assert.equal(called, false);
    const challenge = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED'), 'base64'));
    assert.equal(challenge.accepts[0].network, 'eip155:72344');
    assert.equal(challenge.accepts[0].amount, '1000');
  `, true);
});

test('buyer initializes with the installed viem peer', () => {
  run(`
    import assert from 'node:assert/strict';
    import { privateKeyToAccount } from 'viem/accounts';
    import { createRadiusFetch } from 'radius-sdk/client';
    const signer = privateKeyToAccount('0x' + '01'.repeat(32));
    const payFetch = createRadiusFetch({ network: 'testnet', signer, maxPerRequest: '0.001 SBC' });
    assert.equal(payFetch.address, signer.address);
    assert.equal(payFetch.network.chainId, 72344);
    assert.equal(payFetch.maxPerRequest, 1000n);
  `);
});

test('multi-network buyer imports and runs with explicit viem chains', () => {
  run(`
    import assert from 'node:assert/strict';
    import { base } from 'viem/chains';
    import { privateKeyToAccount } from 'viem/accounts';
    import { createEvmFetch } from 'radius-sdk/client';
    const pay = createEvmFetch({
      signer: privateKeyToAccount('0x' + '01'.repeat(32)),
      networks: [{ chain: base, assets: [{
        asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, name: 'USD Coin', version: '2' },
        maxPerRequest: '0.05',
      }] }],
      fetch: async () => new Response('free'),
    });
    assert.equal(pay.routes[0].network, 'eip155:8453');
    assert.equal(pay.routes[0].maxPerRequest, 50000n);
    assert.equal(await (await pay('https://example.com/free')).text(), 'free');
  `);
});
