#!/usr/bin/env npx tsx
/**
 * e2e step: dispatch a judged verdict to the escrow on Base via the bridge. The
 * relay (GitHub Actions) then carries it; the USDC settles on Base ~25-30 min later.
 * Retriable: the escrow replay-protects, so a duplicate is harmless.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-dispatch.ts <chainId>
 */
import { JUDGE, genlayer } from './e2e-common.js';

const CHAIN_ID = process.argv[2];

async function main() {
  if (!CHAIN_ID) throw new Error('Usage: npx tsx e2e-dispatch.ts <chainId>');
  const { send, read } = genlayer();

  const v: any = await read(JUDGE, 'get_verdict', [CHAIN_ID]);
  if (v.status !== 'judged') throw new Error(`Dispute ${CHAIN_ID} is not judged yet (status=${v.status})`);

  console.log('dispatch_verdict', CHAIN_ID);
  console.log('  verdict       :', v.verdict);
  console.log('  culpable_agent:', v.culpable_agent || '(none)', '\n');

  const r: any = await send(JUDGE, 'dispatch_verdict', [CHAIN_ID]);
  console.log('  tx:', r);
  console.log('\nVerdict emitted to the bridge. Wait ~25-30 min for the relay, then:');
  console.log('  npx tsx e2e-check.ts ' + CHAIN_ID + '   (reads the escrow settlement on Base)');
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-dispatch failed:', e);
  process.exit(1);
});
