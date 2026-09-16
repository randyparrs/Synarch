#!/usr/bin/env npx tsx
/**
 * Diagnose where a dispatched verdict/refund is stuck in the Synarch bridge:
 *   1. reads the Synarch BridgeSender (GenLayer) pending message hashes + targets
 *   2. for each, checks whether the ZKsync forwarder already consumed it (isHashUsed)
 * Tells us if the message never reached the sender, is waiting for the relay, or was
 * forwarded (then LayerZero delivery to Base is the pending leg).
 *
 * Usage (from synarch/scripts):
 *   npx tsx bridge-diag.ts
 */
import { createPublicClient, http, toFunctionSelector, encodeAbiParameters } from 'viem';
import { genlayer } from './e2e-common.js';

const SENDER = '0xffe709e5883f5E669D4aBa35d0544269b28ce3d4' as `0x${string}`; // GenLayer (Studio Next)
const FORWARDER = '0xBCa1b17E4e392A7104f964a8426b7c3f945f288d' as `0x${string}`; // ZKsync
const ZKSYNC_RPC = 'https://sepolia.era.zksync.dev';

async function main() {
  const { read } = genlayer();

  console.log('BridgeSender (GenLayer):', SENDER);
  const hashes: string[] = (await read(SENDER, 'get_message_hashes')) as string[];
  console.log('  pending message hashes:', hashes.length);
  if (!hashes.length) {
    console.log('\n  -> NO messages in the sender. The dispatch never emitted here');
    console.log('     (wrong bridge_sender, or the emit did not materialize). Re-dispatch.');
    process.exit(0);
  }

  const zk = createPublicClient({ transport: http(ZKSYNC_RPC) });
  const isHashUsedSel = toFunctionSelector('function isHashUsed(bytes32) view returns (bool)');

  for (const h of hashes) {
    const hash0x = ('0x' + h) as `0x${string}`;
    const msg: any = await read(SENDER, 'get_message', [h]);
    console.log('\n  message', hash0x);
    console.log('    target_chain_id :', msg.target_chain_id);
    console.log('    target_contract :', msg.target_contract);

    const data = (isHashUsedSel + encodeAbiParameters([{ type: 'bytes32' }], [hash0x]).slice(2)) as `0x${string}`;
    const res = await zk.call({ to: FORWARDER, data });
    const used = res.data && BigInt(res.data) === 1n;
    console.log('    forwarder.isHashUsed:', used ? 'TRUE (forwarded -> LayerZero delivery is the pending leg)' : 'FALSE (relay has NOT forwarded it yet)');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\nbridge-diag failed:', e);
  process.exit(1);
});
