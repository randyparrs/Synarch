#!/usr/bin/env npx tsx
/**
 * Read-only: show the current verdict/dispute state for a chain on the judge.
 * No transaction. Use it to check whether a pending judge_dispute has finalized.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-verdict.ts <chainId>
 */
import { JUDGE, genlayer } from './e2e-common.js';

const CHAIN_ID = process.argv[2];

async function main() {
  if (!CHAIN_ID) throw new Error('Usage: npx tsx e2e-verdict.ts <chainId>');
  const { read } = genlayer();

  const ids: any = await read(JUDGE, 'get_dispute_ids');
  console.log('dispute submitted:', ids.includes(CHAIN_ID));

  const v: any = await read(JUDGE, 'get_verdict', [CHAIN_ID]);
  console.log('\n================ VERDICT', CHAIN_ID, '================');
  console.log('  status        :', v.status, v.status === 'judged' ? '[JUDGED]' : '(not judged yet)');
  console.log('  verdict       :', v.verdict || '(pending)');
  console.log('  culpable_agent:', v.culpable_agent || '(none / NO_FAULT / pending)');
  console.log('  reason        :', v.reason || '(pending)');
  if (v.status === 'judged') {
    console.log('\nJudged. Next: npx tsx e2e-dispatch.ts ' + CHAIN_ID);
  } else {
    console.log('\nNot judged yet. If a judge_dispute tx is pending, wait and re-check; or re-run e2e-judge.ts ' + CHAIN_ID);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-verdict failed:', e);
  process.exit(1);
});
