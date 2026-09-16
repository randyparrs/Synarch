#!/usr/bin/env npx tsx
/**
 * Synarch deploy wiring verification (economy + refund): reads every cross-contract
 * cable between SynarchAgents (GenLayer), SynarchJudge (GenLayer), SynarchEscrow (Base)
 * and the reused AutoProof bridge, and prints OK / FAIL for each. Run before the e2e.
 *
 * Usage (from synarch/scripts):
 *   npx tsx verify-wiring.ts
 *
 * Exit 0 = all on-chain checks OK, 1 = at least one FAIL.
 */
import { createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';

const BASE_RPC = 'https://sepolia.base.org';
const ZKSYNC_RPC = 'https://sepolia.era.zksync.dev';
const GENLAYER_RPC = process.env.GENLAYER_RPC_URL || 'https://studio-next.genlayer.com/api';

// Synarch's OWN bridge infrastructure (independent stack, 2026-09-08).
const BRIDGE_SENDER = '0xffe709e5883f5E669D4aBa35d0544269b28ce3d4'; // GenLayer (Studio Next 61997)
const BRIDGE_RECEIVER = '0x0DcBD91EAe6cFa23510FF2da3A3760F55333e382'; // Base
const BRIDGE_FORWARDER = '0xBCa1b17E4e392A7104f964a8426b7c3f945f288d'; // ZKsync
const RELAYER = '0x8eeE3c0003280452f6cb785759f20C373994B61e'; // Synarch relayer bot
const CALLER_ROLE = '843c3a00fa95510a35f425371231fd3fe4642e719cb4595160763d6d02594b50';

// Synarch deploy (economy + refund).
const AGENTS = '0x21B2b9c92DB2582Aa2cAD02345632387EE34120f'; // SynarchAgents (Studio Next 61997)
const JUDGE = '0x81aE27362Fd23c7cF1A1D9b26ff2052E492778a8'; // SynarchJudge (Studio Next 61997)
const ESCROW = '0x7C12C58B7241924e18E8f1aAbD8F7a7E60c3e1FB'; // SynarchEscrow multi-culprit (Base Sepolia)
const EXPECTED_REFUND_TIMEOUT = 3600; // 1 hour demo default

// Selectors on the escrow (public getters).
const SEL_ALLOWED_SOURCE = '0x1dc52de4';
const SEL_ALLOWED_REFUND_SOURCE = '0xd9134cc4';
const SEL_BRIDGE_RECEIVER = '0x0a208972';
const SEL_REFUND_TIMEOUT = '0xdba26783';
const SEL_HAS_ROLE = '0x91d14854';

async function rpc(url: string, method: string, params: any[]): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const ethCall = (url: string, to: string, data: string) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const addrOf = (result: string) => '0x' + result.slice(-40);
const pad32 = (addrNo0x: string) => '000000000000000000000000' + addrNo0x.toLowerCase();
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, got: string, want: string) {
  results.push({ name, ok });
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${name}${ok ? '' : `\n         got:  ${got}\n         want: ${want}`}`);
}

async function main() {
  console.log('Synarch deploy wiring verification (economy + refund)');
  console.log('  AGENTS =', AGENTS);
  console.log('  JUDGE  =', JUDGE);
  console.log('  ESCROW =', ESCROW, '\n');

  // 1. escrow.allowedSource() == Judge (Base) -- only this judge can settle by verdict
  const allowed = addrOf(await ethCall(BASE_RPC, ESCROW, SEL_ALLOWED_SOURCE));
  check('escrow.allowedSource -> Judge (Base)', eq(allowed, JUDGE), allowed, JUDGE);

  // 2. escrow.allowedRefundSource() == Agents (Base) -- only agents can trigger refunds
  const refundSrc = addrOf(await ethCall(BASE_RPC, ESCROW, SEL_ALLOWED_REFUND_SOURCE));
  check('escrow.allowedRefundSource -> Agents (Base)', eq(refundSrc, AGENTS), refundSrc, AGENTS);

  // 3. escrow.bridgeReceiver() == BridgeReceiver (Base)
  const rcv = addrOf(await ethCall(BASE_RPC, ESCROW, SEL_BRIDGE_RECEIVER));
  check('escrow.bridgeReceiver (Base)', eq(rcv, BRIDGE_RECEIVER), rcv, BRIDGE_RECEIVER);

  // 4. escrow.refundTimeout() == 3600 (Base) -- rule B demo default
  const rt = parseInt(await ethCall(BASE_RPC, ESCROW, SEL_REFUND_TIMEOUT), 16);
  check('escrow.refundTimeout == 1h (Base)', rt === EXPECTED_REFUND_TIMEOUT, `${rt}s`, `${EXPECTED_REFUND_TIMEOUT}s`);

  // 5. forwarder.hasRole(CALLER_ROLE, relayer) == true (ZKsync)
  const hrData = SEL_HAS_ROLE + CALLER_ROLE + pad32(RELAYER.slice(2));
  const hr: string = await ethCall(ZKSYNC_RPC, BRIDGE_FORWARDER, hrData);
  check('relayer has CALLER_ROLE (ZKsync)', parseInt(hr, 16) === 1, hr, 'true (0x..01)');

  // 6. relayer ETH balance > 0 (ZKsync, gas)
  const balHex: string = await rpc(ZKSYNC_RPC, 'eth_getBalance', [RELAYER, 'latest']);
  const bal = BigInt(balHex);
  check('relayer has gas (ZKsync ETH)', bal > 0n, (Number(bal) / 1e18).toFixed(6) + ' ETH', '> 0');

  const client: any = createClient({
    chain: studioDevnet, // 61997
    endpoint: GENLAYER_RPC,
  });

  // Studio Next returns -32006 ("all execution slots occupied") and the odd HTML
  // gateway page under load, so every GenLayer read is retried before being called a
  // FAIL. Without this a busy node looks identical to a broken cable.
  async function readConfig(address: string): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.readContract({ address, functionName: 'get_config', args: [] });
      } catch (e: any) {
        const msg = String(e?.message || e);
        const transient = /-32006|-32005|busy|slots occupied|capacity|timed out|not valid JSON|DOCTYPE/i.test(msg);
        if (transient && attempt < 12) {
          const wait = Math.min(15000, 2000 * attempt);
          console.log(`  (node busy, retry ${attempt} in ${wait}ms)`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
  }

  // 7 + 8. Judge.get_config() -> bridge_sender + escrow_contract (GenLayer)
  const jcfg: any = await readConfig(JUDGE);
  check('Judge.bridge_sender (GenLayer)', eq(jcfg.bridge_sender, BRIDGE_SENDER), jcfg.bridge_sender, BRIDGE_SENDER);
  check('Judge.escrow_contract (GenLayer)', eq(jcfg.escrow_contract, ESCROW), jcfg.escrow_contract, ESCROW);

  // 9 + 10. Agents.get_config() -> bridge_sender + escrow_contract (GenLayer)
  const acfg: any = await readConfig(AGENTS);
  check('Agents.bridge_sender (GenLayer)', eq(acfg.bridge_sender, BRIDGE_SENDER), acfg.bridge_sender, BRIDGE_SENDER);
  check('Agents.escrow_contract (GenLayer)', eq(acfg.escrow_contract, ESCROW), acfg.escrow_contract, ESCROW);

  const failed = results.filter((r) => !r.ok);
  console.log(
    '\n' +
      (failed.length === 0
        ? `ALL ${results.length} ON-CHAIN CHECKS OK.\n(manual: confirm the relay workflow is running on GitHub Actions before the e2e.)`
        : `${failed.length} CHECK(S) FAILED, fix before the e2e: ${failed.map((r) => r.name).join(', ')}`),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-wiring failed:', e);
  process.exit(1);
});
