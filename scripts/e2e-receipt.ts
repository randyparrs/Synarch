#!/usr/bin/env npx tsx
/**
 * Diagnostic: fetch and dump a GenLayer transaction receipt (status, consensus,
 * leader result / errors) to see WHY a judge_dispute did not settle (NO_MAJORITY
 * vs an actual execution error).
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-receipt.ts <txHash>
 */
import { genlayer } from './e2e-common.js';

const HASH = process.argv[2];
const bigints = (_k: string, v: any) => (typeof v === 'bigint' ? v.toString() : v);

async function main() {
  if (!HASH) throw new Error('Usage: npx tsx e2e-receipt.ts <txHash>');
  const { client } = genlayer();

  let receipt: any;
  try {
    receipt = await (client as any).getTransactionReceipt({ hash: HASH });
  } catch {
    // Fallback: some genlayer-js versions expose only waitForTransactionReceipt.
    receipt = await (client as any).waitForTransactionReceipt({ hash: HASH, retries: 3 }).catch((e: any) => ({ error: String(e?.message || e) }));
  }

  console.log('Receipt for', HASH, ':\n');
  console.log(JSON.stringify(receipt, bigints, 2).slice(0, 8000));
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-receipt failed:', e);
  process.exit(1);
});
