// Buyer side of the demo. Everything payment-related goes through radius-sdk/client;
// this file is only wiring between buttons, inputs and result boxes.
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError, type PaymentOffer, type RadiusFetch } from 'radius-sdk/client';
import { FaucetError, type FaucetStatus } from 'radius-sdk/faucet';
import { radiusMainnet, radiusTestnet, type RadiusNetwork } from 'radius-sdk';
import { createWalletClient, custom, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?(event: string, handler: (...args: unknown[]) => void): void };
declare global { interface Window { ethereum?: Eip1193 } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEY_STORAGE = 'radius-demo-burner-key';
const PREFS_STORAGE = 'radius-demo-prefs';

type Prefs = { network?: string; signerMode?: string };
function loadPrefs(): Prefs { try { return JSON.parse(localStorage.getItem(PREFS_STORAGE) ?? '{}'); } catch { return {}; } }
function savePrefs(patch: Prefs) { localStorage.setItem(PREFS_STORAGE, JSON.stringify({ ...loadPrefs(), ...patch })); }

// ---- state -------------------------------------------------------------------
const networks: Record<string, RadiusNetwork> = { testnet: radiusTestnet, mainnet: radiusMainnet };
const netSel = $<HTMLSelectElement>('network');
const modeSel = $<HTMLSelectElement>('signerMode');
let metamask: WalletClient | undefined;

function network(): RadiusNetwork { return networks[netSel.value]; }
function burnerKey(): `0x${string}` {
  let k = localStorage.getItem(KEY_STORAGE) as `0x${string}` | null;
  if (!k) { k = generatePrivateKey(); localStorage.setItem(KEY_STORAGE, k); log('generated a new burner key (stored in localStorage)'); }
  return k;
}

/** One createRadiusFetch per action, so the settings inputs always apply. */
function buyer(): RadiusFetch {
  const signer = modeSel.value === 'metamask' ? metamask : burnerKey();
  if (!signer) throw new Error('Connect MetaMask first (Wallet card)');
  return createRadiusFetch({
    network: network(),
    // The faucet API has no CORS headers; the worker proxies it at /faucet (see src/worker.ts).
    // The SDK's faucet client (buyer().faucet / buyer().fund()) then talks to this origin.
    faucetUrl: `${location.origin}/faucet`,
    signer,
    maxPerRequest: $<HTMLInputElement>('c-max').value || '$0',
    permit2Approval: $<HTMLInputElement>('c-neverApprove').checked ? 'never' : 'auto',
    onPaymentRequired: (offer: PaymentOffer) => {
      log(`offer: ${offer.amountFormatted} → ${short(offer.payTo)} for ${offer.resource.url}${offer.gasSponsored ? ' (approval sponsored)' : ''}`);
      if ($<HTMLInputElement>('c-decline').checked) { log('declining (checkbox)', 'warn'); return false; }
      return true;
    },
    onApprovalRequired: (r) => {
      log(`Permit2 approval needed: allowance ${r.currentAllowance} < ${r.offer.amount}; sending unlimited approval`, 'warn');
      if ($<HTMLInputElement>('c-vetoApproval').checked) { log('vetoing approval (checkbox)', 'warn'); return false; }
      return true;
    },
    onPaid: (receipt) => log(`paid ${receipt.amount} → tx ${receipt.transaction}`, 'ok'),
  });
}

// ---- helpers -----------------------------------------------------------------
function short(a: string) { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }
function log(msg: string, cls: '' | 'ok' | 'bad' | 'warn' = '') {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.prepend(line);
}
function show(id: string, value: unknown) {
  $(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
function fail(id: string, e: unknown) {
  // FaucetError carries the faucet API's own code (rate_limited, faucet_empty, …) under the SDK's 'faucet' code.
  const msg = e instanceof FaucetError ? `[faucet:${e.faucetCode}] ${e.message}` : e instanceof RadiusPaymentError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e);
  show(id, `ERROR ${msg}`);
  log(msg, 'bad');
}
async function run(id: string, btn: HTMLButtonElement | null, fn: () => Promise<unknown>) {
  if (btn) btn.disabled = true;
  try { show(id, await fn()); } catch (e) { fail(id, e); } finally { if (btn) btn.disabled = false; }
}
function decode402(res: Response) {
  const h = res.headers.get('payment-required');
  if (!h) return { note: 'no PAYMENT-REQUIRED header' };
  return { paymentRequired: JSON.parse(atob(h)) };
}
async function describe(res: Response) {
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  const receipt = getPaymentReceipt(res, network());
  return { status: res.status, body, receipt, ...(res.status === 402 ? decode402(res) : {}) };
}

// ---- wallet card -------------------------------------------------------------
async function refreshWallet() {
  try {
    const b = buyer();
    $('w-address').textContent = b.address;
    const [bal, allowance] = await Promise.all([b.balance(), b.permit2Allowance()]);
    $('w-balance').textContent = bal.formatted;
    $('w-allowance').textContent = allowance >= 2n ** 200n ? 'unlimited' : allowance.toString();
    // GET /status/:address on the faucet: drip size and whether this wallet may drip right now.
    $('w-faucet').textContent = b.faucet ? await b.faucet.status(b.address).then(describeFaucet, (e) => `unavailable (${e instanceof Error ? e.message : e})`) : 'none for this network';
    $('status').textContent = `${network().name} · ${modeSel.value === 'metamask' ? 'MetaMask' : 'burner'} · ${short(b.address)}`;
  } catch (e) {
    $('status').textContent = e instanceof Error ? e.message : String(e);
  }
}
function describeFaucet(s: FaucetStatus): string {
  const drip = s.dripAmount ? `${s.dripAmount} ${s.token} per drip` : s.token;
  if (s.rateLimited) return `${drip} · rate limited${s.retryAfterMs ? `, retry in ${Math.ceil(s.retryAfterMs / 1000)} s` : ''}`;
  return s.remainingRequests !== undefined ? `${drip} · ${s.remainingRequests} requests left` : drip;
}
$('w-refresh').onclick = refreshWallet;
$('w-new').onclick = () => { if (confirm('Generate a new burner key? The old one is discarded.')) { localStorage.removeItem(KEY_STORAGE); burnerKey(); modeSel.value = 'burner'; refreshWallet(); } };
$('w-import').onclick = () => { const k = prompt('Private key (0x…)'); if (k && /^0x[0-9a-fA-F]{64}$/.test(k)) { localStorage.setItem(KEY_STORAGE, k); modeSel.value = 'burner'; refreshWallet(); } else if (k) alert('not a 32-byte hex key'); };
$('w-export').onclick = () => show('w-result', { burnerPrivateKey: burnerKey(), note: 'test funds only' });
// fund(): unsigned drip first; if the faucet answers signature_required the SDK fetches the
// challenge, asks the signer (burner key, or a MetaMask personal_sign prompt) and drips again.
$('w-fund').onclick = (ev) => run('w-result', ev.target as HTMLButtonElement, async () => {
  const r = await buyer().fund();
  log(`faucet dripped ${r.amount ?? '?'} ${r.token} (${r.explorerUrl ?? r.txHash})`, 'ok');
  await refreshWallet();
  return r;
});
$('w-approve').onclick = (ev) => run('w-result', ev.target as HTMLButtonElement, async () => { const r = await buyer().approvePermit2(); await refreshWallet(); return r; });
$('w-send').onclick = (ev) => run('w-result', ev.target as HTMLButtonElement, async () => {
  const to = $<HTMLInputElement>('w-sendTo').value.trim() as `0x${string}`;
  const r = await buyer().send(to, $<HTMLInputElement>('w-sendAmt').value);
  await refreshWallet();
  return r;
});
/** Connect the injected wallet. `silent` only reuses an existing authorisation (no prompt), for page load. */
async function connectMetaMask(silent = false) {
  if (!window.ethereum) throw new Error('No injected wallet found (window.ethereum)');
  // The SDK network carries its viem Chain (id, RPC, explorer); MetaMask gets that definition via addChain.
  const chain = network().chain;
  const accounts = (await window.ethereum.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as `0x${string}`[];
  if (!accounts.length) throw new Error(silent ? 'MetaMask not authorised for this site yet; click Connect MetaMask' : 'No account returned');
  const wc = createWalletClient({ account: accounts[0], chain, transport: custom(window.ethereum) });
  try { await wc.switchChain({ id: chain.id }); } catch { await wc.addChain({ chain }); await wc.switchChain({ id: chain.id }); }
  metamask = wc;
  modeSel.value = 'metamask';
  savePrefs({ signerMode: 'metamask' });
  return { connected: accounts[0], chainId: chain.id };
}
$('w-connect').onclick = (ev) => run('w-result', ev.target as HTMLButtonElement, async () => { const r = await connectMetaMask(); await refreshWallet(); return r; });
// Follow account/chain changes in the wallet extension.
window.ethereum?.on?.('accountsChanged', () => { if (modeSel.value === 'metamask') connectMetaMask(true).then(refreshWallet).catch((e) => log(e.message, 'warn')); });
window.ethereum?.on?.('chainChanged', () => { if (modeSel.value === 'metamask') refreshWallet(); });

// ---- seller card -------------------------------------------------------------
async function loadServer() {
  const info = await (await fetch('/api/info')).json() as { network: string; caip2: string; payTo: string; routes: { route: string; price: string; description: string }[] };
  const kv = $('s-info');
  kv.innerHTML = '';
  for (const [k, v] of [['network', `${info.network} (${info.caip2})`], ['payTo', info.payTo], ['facilitator', 'Radius (live /supported lookup)']]) {
    kv.insertAdjacentHTML('beforeend', `<b>${k}</b><span>${v}</span>`);
  }
  if (info.network !== netSel.value) { netSel.value = info.network; savePrefs({ network: info.network }); log(`switched page network to ${info.network} to match the server`); }
  const list = $('s-routes');
  list.innerHTML = '';
  for (const r of info.routes) {
    const [method, path] = r.route.split(' ');
    const row = document.createElement('div');
    row.className = 'route';
    row.innerHTML = `<div><code>${r.route}</code> <span class="price">${r.price}</span><br><span class="price">${r.description}</span></div><button data-plain>Fetch unpaid</button><button class="primary" data-pay>Pay &amp; fetch</button>`;
    const url = new URL(path === '/api/lookup' ? `${path}?ip=1.2.3.4` : path, location.origin).href;
    const init: RequestInit = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'radius', at: Date.now() }) } : {};
    row.querySelector<HTMLButtonElement>('[data-plain]')!.onclick = (ev) => run('s-result', ev.target as HTMLButtonElement, async () => describe(await fetch(url, init)));
    row.querySelector<HTMLButtonElement>('[data-pay]')!.onclick = (ev) => run('s-result', ev.target as HTMLButtonElement, async () => { const out = await describe(await buyer()(url, init)); refreshWallet(); return out; });
    list.appendChild(row);
  }
}

// ---- pay any URL -------------------------------------------------------------
function anyInit(): RequestInit {
  const method = $<HTMLSelectElement>('u-method').value;
  const body = $<HTMLTextAreaElement>('u-body').value.trim();
  return method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: body || '{}' } : { method };
}
$('u-go').onclick = (ev) => run('u-result', ev.target as HTMLButtonElement, async () => { const out = await describe(await buyer()($<HTMLInputElement>('u-url').value.trim(), anyInit())); refreshWallet(); return out; });
$('u-plain').onclick = (ev) => run('u-result', ev.target as HTMLButtonElement, async () => describe(await fetch($<HTMLInputElement>('u-url').value.trim(), anyInit())));

// ---- reconcile ---------------------------------------------------------------
$('r-go').onclick = (ev) => run('r-result', ev.target as HTMLButtonElement, async () => {
  const hash = $<HTMLInputElement>('r-hash').value.trim() as `0x${string}`;
  const s = await buyer().getSettlement(hash);
  if (!s) return { found: false, note: 'unknown to the node (pending or never existed)' };
  return { status: s.status, blockNumber: s.blockNumber, transfers: s.transfers, totalPaid: s.paidFormatted(), explorerUrl: s.explorerUrl };
});

// ---- boot --------------------------------------------------------------------
// Preferences (network, signer) and the burner key persist in this browser's localStorage for this origin.
const prefs = loadPrefs();
if (prefs.network && networks[prefs.network]) netSel.value = prefs.network;
if (prefs.signerMode) modeSel.value = prefs.signerMode;
netSel.onchange = () => { savePrefs({ network: netSel.value }); if (modeSel.value === 'metamask') connectMetaMask(true).then(refreshWallet).catch((e) => log(e.message, 'warn')); else refreshWallet(); };
modeSel.onchange = () => {
  savePrefs({ signerMode: modeSel.value });
  if (modeSel.value === 'metamask' && !metamask) connectMetaMask().then(refreshWallet).catch((e) => { log(e.message, 'bad'); modeSel.value = 'burner'; savePrefs({ signerMode: 'burner' }); refreshWallet(); });
  else refreshWallet();
};
$<HTMLInputElement>('u-url').value = `${location.origin}/api/quote`;
loadServer()
  .then(async () => {
    if (modeSel.value === 'metamask') {
      try { await connectMetaMask(true); log('reconnected MetaMask'); }
      catch (e) { log(`${e instanceof Error ? e.message : e}; using burner`, 'warn'); modeSel.value = 'burner'; }
    }
    await refreshWallet();
  })
  .catch((e) => { $('status').textContent = `server info failed: ${e.message}`; });
