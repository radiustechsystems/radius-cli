/**
 * Live check of the balance split against a real Radius node: the raw native balance read
 * through the EVM plus the SBC holdings (1:1, rescaled to 18 decimals) must equal what
 * `eth_getBalance` aggregates. Read-only; any funded or unfunded key works.
 *
 *   RADIUS_E2E=1 RADIUS_PRIVATE_KEY=0x… [RADIUS_NETWORK=mainnet] npx vitest run test/e2e/balances
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getBalances, radiusActions } from '../../src/balances.js';
import { resolveNetwork } from '../../src/networks.js';
import { createRadiusFetch } from '../../src/client/index.js';

const KEY = process.env.RADIUS_PRIVATE_KEY as `0x${string}` | undefined;
const NET = (process.env.RADIUS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const run = process.env.RADIUS_E2E && KEY ? describe : describe.skip;

run(`${NET} e2e: native vs stablecoin balances`, () => {
  const network = resolveNetwork(NET);
  const address = privateKeyToAccount(KEY!).address;

  it('reads the raw native balance through the EVM and reconciles with eth_getBalance', async () => {
    const client = createPublicClient({ chain: network.chain, transport: http() }).extend(radiusActions());
    const b = await client.getBalances({ address });
    expect(b.native.rawSource).toBe('evm');
    const sbc = b.tokens.find((t) => t.symbol === 'SBC')!;
    expect(sbc.atomic).toBe(await client.readContract({
      address: sbc.address,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [address],
    }));
    expect(b.native.aggregate).toBe(await client.getBalance({ address }));
    // The docs say SBC is valued 1:1 (10^6 SBC units == 10^18 wei) with no cap.
    expect(b.native.raw + sbc.atomic * 10n ** 12n).toBe(b.native.aggregate);
    expect(b.native.raw).toBeLessThanOrEqual(b.native.aggregate);
  }, 30_000);

  it('createRadiusFetch().balances() matches getBalances()', async () => {
    const payFetch = createRadiusFetch({ network: NET, signer: KEY!, maxPerRequest: '$0.01' });
    const [a, b] = await Promise.all([payFetch.balances(), getBalances(createPublicClient({ chain: network.chain, transport: http() }), { address })]);
    expect(a.native.raw).toBe(b.native.raw);
    expect(a.tokens[0].atomic).toBe(b.tokens[0].atomic);
    expect((await payFetch.balance()).atomic).toBe(a.tokens[0].atomic);
  }, 30_000);
});
