#!/usr/bin/env npx tsx
/**
 * Stage 5 of the Synarch independence migration: repoint a GenLayer contract
 * (SynarchJudge or SynarchAgents) at Synarch's OWN bridge + escrow. Sets:
 *   - bridge_sender    -> SynarchBridgeSender (GenLayer), the one the new relay polls
 *   - escrow_contract  -> the fresh SynarchEscrow (Base), target_chain_eid = Base 40245
 * Both setters are owner-gated; run with the deployer/owner key in .env.
 *
 * Usage (from synarch/scripts), run once per contract:
 *   npx tsx rewire-bridge.ts 0x81aE27362Fd23c7cF1A1D9b26ff2052E492778a8   # Judge
 *   npx tsx rewire-bridge.ts 0x21B2b9c92DB2582Aa2cAD02345632387EE34120f   # Agents
 */
import { genlayer } from './e2e-common.js';

// Synarch independent stack. Escrow redeployed 2026-09-13 with the _resolveDeposit fix
// (on a fault: culpable share -> client, honest agents keep their share).
const NEW_BRIDGE_SENDER = '0x63df09A8D5542E212EB780B4cDb837fB05A2f1c3';
const NEW_ESCROW = '0x7C12C58B7241924e18E8f1aAbD8F7a7E60c3e1FB';
const BASE_EID = 40245;

const CONTRACT = (process.argv[2] || '') as `0x${string}`;

async function main() {
  if (!CONTRACT) throw new Error('Usage: npx tsx rewire-bridge.ts <CONTRACT_ADDRESS>');
  const { send, read } = genlayer();

  console.log('Re-wiring', CONTRACT);
  console.log('  bridge_sender   ->', NEW_BRIDGE_SENDER);
  console.log('  escrow_contract ->', NEW_ESCROW, '(eid', BASE_EID + ')\n');

  console.log('set_bridge_sender...');
  await send(CONTRACT, 'set_bridge_sender', [NEW_BRIDGE_SENDER]);

  console.log('set_escrow_contract...');
  await send(CONTRACT, 'set_escrow_contract', [NEW_ESCROW, BASE_EID]);

  const cfg: any = await read(CONTRACT, 'get_config');
  const okSender = String(cfg.bridge_sender).toLowerCase() === NEW_BRIDGE_SENDER.toLowerCase();
  const okEscrow = String(cfg.escrow_contract).toLowerCase() === NEW_ESCROW.toLowerCase();
  const okEid = Number(cfg.target_chain_eid) === BASE_EID;

  console.log('\n  get_config().bridge_sender    =', cfg.bridge_sender, okSender ? '[OK]' : '[MISMATCH]');
  console.log('  get_config().escrow_contract  =', cfg.escrow_contract, okEscrow ? '[OK]' : '[MISMATCH]');
  console.log('  get_config().target_chain_eid =', cfg.target_chain_eid, okEid ? '[OK]' : '[MISMATCH]');
  process.exit(okSender && okEscrow && okEid ? 0 : 1);
}

main().catch((e) => {
  console.error('\nrewire-bridge failed:', e);
  process.exit(1);
});
