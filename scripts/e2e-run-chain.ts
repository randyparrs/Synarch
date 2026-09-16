#!/usr/bin/env npx tsx
/**
 * e2e step: open a delegation chain and run its 3 steps (data-agent -> analyst ->
 * researcher). Each step is one AI-consensus tx; the output of each feeds the next.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-run-chain.ts <chainId> ["<agreement>"] [--steps N]
 *
 * --steps N caps how many steps to run (default: all). Use --steps 0 to only open the
 * chain (for a rule-A cancel test) or --steps 1 to start then stall (for a rule-B test).
 * The chainId doubles as the escrow agreementId and the judge dispute_id later.
 */
import { AGENTS, AGENT_IDS, genlayer } from './e2e-common.js';

const CHAIN_ID = process.argv[2];
const stepsFlag = process.argv.indexOf('--steps');
const MAX_STEPS = stepsFlag >= 0 ? parseInt(process.argv[stepsFlag + 1], 10) : Infinity;
const AGREEMENT =
  (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined) ||
  "Determine whether Netflix's most recent reported annual revenue was higher than Disney's, and by roughly how much.";

async function main() {
  if (!CHAIN_ID) throw new Error('Usage: npx tsx e2e-run-chain.ts <chainId> ["<agreement>"]');
  const { send, read, me } = genlayer();

  console.log('open_chain');
  console.log('  chain_id :', CHAIN_ID);
  console.log('  client   :', me);
  console.log('  agreement:', AGREEMENT);
  console.log('  plan     :', AGENT_IDS.join(' -> '), '\n');

  const existing: any = await read(AGENTS, 'get_chain_ids');
  if (!existing.includes(CHAIN_ID)) {
    await send(AGENTS, 'open_chain', [CHAIN_ID, AGREEMENT, me, AGENT_IDS]);
    console.log('  chain opened\n');
  } else {
    console.log('  chain already exists, resuming\n');
  }

  // Run steps until complete or MAX_STEPS reached. Re-running is safe: completed
  // steps are not re-run.
  for (let i = 0; i < AGENT_IDS.length; i++) {
    const chain: any = await read(AGENTS, 'get_chain', [CHAIN_ID]);
    if (chain.status === 'complete') break;
    if (chain.steps_done >= MAX_STEPS) {
      console.log(`  reached --steps ${MAX_STEPS}, stopping (chain left at ${chain.steps_done}/${chain.steps_total})`);
      break;
    }
    const stepIdx = chain.steps_done;
    console.log(`run_next_step [${stepIdx}] (${AGENT_IDS[stepIdx]}) -- AI consensus, may take minutes...`);
    const r: any = await send(AGENTS, 'run_next_step', [CHAIN_ID]);
    console.log('  tx:', r);
  }

  const chain: any = await read(AGENTS, 'get_chain', [CHAIN_ID]);
  console.log('\n================ CHAIN', CHAIN_ID, '(', chain.status, ') ================');
  for (const s of chain.steps) {
    console.log(`\n--- [${s.role}] agent=${s.agent_id} owner=${s.agent_addr} ---`);
    console.log(s.delivered);
  }
  console.log('\nsteps_done =', chain.steps_done, '/', chain.steps_total);
  console.log(chain.status === 'complete' ? '\nChain COMPLETE. Next: npx tsx e2e-judge.ts ' + CHAIN_ID : '\nChain not complete yet, re-run to continue.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-run-chain failed:', e);
  process.exit(1);
});
