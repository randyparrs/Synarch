#!/usr/bin/env npx tsx
/**
 * e2e step: read the escrow settlement/refund state for a chain on Base Sepolia,
 * plus the relevant USDC balances. Run after a dispatch (verdict) or a refund to
 * confirm the money moved.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-check.ts <chainId>
 */
import { createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { AGENTS, AGENT_IDS, ESCROW, USDC, genlayer } from './e2e-common.js';

const CHAIN_ID = process.argv[2];

const ESCROW_ABI = [
  { type: 'function', name: 'getAgreement', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [
    { name: 'exists', type: 'bool' }, { name: 'settled', type: 'bool' }, { name: 'client', type: 'address' },
    { name: 'verdict', type: 'string' }, { name: 'culpableAgent', type: 'address' }, { name: 'total', type: 'uint256' }, { name: 'depositCount', type: 'uint256' },
  ] },
  { type: 'function', name: 'balance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'fundedAt', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'refundTimeout', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;
const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

async function main() {
  if (!CHAIN_ID) throw new Error('Usage: npx tsx e2e-check.ts <chainId>');
  const pub = createPublicClient({ chain: baseSepolia, transport: http() });
  const me = privateKeyToAccount((process.env.PRIVATE_KEY!.startsWith('0x') ? process.env.PRIVATE_KEY! : `0x${process.env.PRIVATE_KEY}`) as `0x${string}`).address;

  const a: any = await pub.readContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'getAgreement', args: [CHAIN_ID] });
  const escrowBal = (await pub.readContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'balance' })) as bigint;
  const fundedAt = (await pub.readContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'fundedAt', args: [CHAIN_ID] })) as bigint;
  const timeout = (await pub.readContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'refundTimeout' })) as bigint;

  console.log('================ ESCROW', CHAIN_ID, '================');
  console.log('  exists        :', a[0]);
  console.log('  settled       :', a[1]);
  console.log('  client        :', a[2]);
  console.log('  verdict       :', a[3] || '(unsettled)');
  console.log('  culpableAgent :', a[4]);
  console.log('  total held    :', formatUnits(a[5], 6), 'USDC');
  console.log('  depositCount  :', a[6].toString());
  console.log('  escrow balance:', formatUnits(escrowBal, 6), 'USDC (0 once settled/refunded)');

  if (fundedAt > 0n) {
    const eligible = Number(fundedAt + timeout);
    const now = Math.floor(Date.now() / 1000);
    const mins = Math.max(0, Math.ceil((eligible - now) / 60));
    console.log('  refund window : timeout', Number(timeout), 's; timeout-refund eligible', mins === 0 ? 'NOW' : `in ~${mins} min`);
  }

  console.log('\n  --- USDC balances ---');
  console.log('  client/deployer :', me);
  const meBal = (await pub.readContract({ address: USDC as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] })) as bigint;
  console.log('    balance:', formatUnits(meBal, 6), 'USDC');

  const { read } = genlayer();
  for (const id of AGENT_IDS) {
    const p: any = await read(AGENTS, 'get_profile', [id]);
    const bal = (await pub.readContract({ address: USDC as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [p.owner as `0x${string}`] })) as bigint;
    console.log(`  ${id} owner ${p.owner}: ${formatUnits(bal, 6)} USDC`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-check failed:', e);
  process.exit(1);
});
