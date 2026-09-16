#!/usr/bin/env npx tsx
/**
 * e2e step: trigger a client refund on the agents contract, dispatched to the escrow
 * via the bridge (the escrow refunds each recorded depositor).
 *   - cancel  (rule A): only while the chain is intact (no step has run).
 *   - timeout (rule B): only while the chain is not complete; the escrow honors it
 *     only after refundTimeout (1h) has elapsed on its Base clock.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-refund.ts <chainId> <cancel|timeout>
 *
 * After running, wait for the relay (~25-30 min) then: npx tsx e2e-check.ts <chainId>
 */
import { AGENTS, genlayer } from './e2e-common.js';

const CHAIN_ID = process.argv[2];
const MODE = (process.argv[3] || '').toLowerCase();

async function main() {
  if (!CHAIN_ID || (MODE !== 'cancel' && MODE !== 'timeout')) {
    throw new Error('Usage: npx tsx e2e-refund.ts <chainId> <cancel|timeout>');
  }
  const { send, read } = genlayer();

  const chain: any = await read(AGENTS, 'get_chain', [CHAIN_ID]);
  console.log('refund', MODE, 'for chain', CHAIN_ID);
  console.log('  chain status:', chain.status, '| steps_done:', chain.steps_done, '/', chain.steps_total, '\n');

  const fn = MODE === 'cancel' ? 'cancel_chain' : 'claim_timeout';
  const r: any = await send(AGENTS, fn, [CHAIN_ID]);
  console.log(' ', fn, 'tx:', r);

  if (MODE === 'cancel') {
    console.log('\nCANCEL dispatched (immediate refund). The escrow refunds each depositor once the relay carries it.');
  } else {
    console.log('\nTIMEOUT dispatched. The escrow refunds ONLY if 1h has elapsed since funding;');
    console.log('if not yet, it reverts on the Base side and you can re-run this later (idempotent, escrow is one-shot).');
  }
  console.log('Wait ~25-30 min for the relay, then: npx tsx e2e-check.ts ' + CHAIN_ID);
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-refund failed:', e);
  process.exit(1);
});
