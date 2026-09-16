#!/usr/bin/env npx tsx
/**
 * e2e step: dispute a completed chain. Reads export_for_judge from the agents
 * contract (off-chain), submits it to the judge as an N-link dispute (same id),
 * runs judge_dispute (real validator consensus), and prints the verdict.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-judge.ts <chainId> ["<evidence_url>"]
 */
import { AGENTS, JUDGE, genlayer, sleep } from './e2e-common.js';

const CHAIN_ID = process.argv[2];
const EVIDENCE_URL = process.argv[3] || '';

async function main() {
  if (!CHAIN_ID) throw new Error('Usage: npx tsx e2e-judge.ts <chainId> ["<evidence_url>"]');
  const { send, read } = genlayer();

  const exp: any = await read(AGENTS, 'export_for_judge', [CHAIN_ID]);
  if (exp.status !== 'complete') throw new Error(`Chain ${CHAIN_ID} is not complete (status=${exp.status}); run e2e-run-chain first`);

  console.log('export_for_judge', CHAIN_ID);
  console.log('  agreement:', exp.agreement);
  console.log('  roles    :', exp.roles.join(' -> '));
  console.log('  agents   :', exp.agents.join(', '), '\n');

  // Submit the chain as a dispute (skip if already submitted).
  const ids: any = await read(JUDGE, 'get_dispute_ids');
  if (!ids.includes(CHAIN_ID)) {
    console.log('submit_chain_dispute...');
    await send(JUDGE, 'submit_chain_dispute', [
      CHAIN_ID,
      exp.agreement,
      exp.roles,
      exp.agents,
      exp.delivered,
      'client disputes the final result',
      'client disputes the final result',
      EVIDENCE_URL,
    ]);
  } else {
    console.log('dispute already submitted');
  }

  // judge_dispute reaches consensus by validator MAJORITY. On a subjective chain it
  // can hit NO_MAJORITY: the tx is accepted but state does not change. The fix is to
  // RE-SEND (a fresh committee each attempt), not just poll. Safe: once one attempt
  // finalizes as judged, a later judge_dispute reverts "already judged".
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cur: any = await read(JUDGE, 'get_verdict', [CHAIN_ID]);
    if (cur.status === 'judged') break;
    console.log(`\njudge_dispute attempt ${attempt}/${MAX_ATTEMPTS} -- AI consensus over the chain...`);
    try {
      const h = await send(JUDGE, 'judge_dispute', [CHAIN_ID]);
      console.log('  tx:', h);
    } catch (e: any) {
      console.log('  attempt did not settle (' + String(e?.message || e).slice(0, 70) + ')');
    }
    // brief poll: the state may appear shortly after the attempt
    for (let i = 0; i < 6; i++) {
      const v2: any = await read(JUDGE, 'get_verdict', [CHAIN_ID]);
      if (v2.status === 'judged') break;
      await sleep(12000);
    }
  }

  const v: any = await read(JUDGE, 'get_verdict', [CHAIN_ID]);
  if (v.status !== 'judged') {
    console.log(`\nStill NO_MAJORITY after ${MAX_ATTEMPTS} attempts. The chain may be genuinely hard for the validators`);
    console.log('to agree on (subjective correctness). Re-run this command to try more committees, or inspect a');
    console.log('judge tx with:  npx tsx e2e-receipt.ts <judge_dispute_txHash>');
    process.exit(1);
  }
  console.log('\n================ VERDICT', CHAIN_ID, '================');
  console.log('  status        :', v.status);
  console.log('  verdict       :', v.verdict, '(the role that broke the chain, or NO_FAULT)');
  console.log('  culpable_agent:', v.culpable_agent || '(none - NO_FAULT)');
  console.log('  reason        :', v.reason);
  console.log('\nNext: npx tsx e2e-dispatch.ts ' + CHAIN_ID + '   (sends the verdict across the bridge to the escrow)');
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-judge failed:', e);
  process.exit(1);
});
