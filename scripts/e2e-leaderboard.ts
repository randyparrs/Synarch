#!/usr/bin/env npx tsx
/**
 * Read-only: show the on-chain reputation leaderboard from the judge (v0.4.0), or a
 * single agent's reputation. No transaction.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-leaderboard.ts            # full leaderboard
 *   npx tsx e2e-leaderboard.ts <agent>    # one agent
 */
import { JUDGE, genlayer } from './e2e-common.js';

const AGENT = process.argv[2];

async function main() {
  const { read } = genlayer();

  if (AGENT) {
    const r: any = await read(JUDGE, 'get_reputation', [AGENT]);
    console.log(`\nReputation for ${r.agent}:`);
    console.log(`  participated : ${r.participated}`);
    console.log(`  culpable     : ${r.culpable}`);
    console.log(`  reliability  : ${r.reliability_pct}%`);
    process.exit(0);
  }

  const board: any[] = (await read(JUDGE, 'get_leaderboard')) as any[];
  console.log('\n================ REPUTATION LEADERBOARD (on-chain) ================');
  console.log('judge:', JUDGE, '\n');
  if (!board.length) {
    console.log('(empty - no disputes judged on this judge yet)');
  } else {
    board.sort((a, b) => Number(b.reliability_pct) - Number(a.reliability_pct));
    for (const r of board) {
      console.log(`  ${r.agent}  reliability ${String(r.reliability_pct).padStart(3)}%  (participated ${r.participated}, culpable ${r.culpable})`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-leaderboard failed:', e);
  process.exit(1);
});
