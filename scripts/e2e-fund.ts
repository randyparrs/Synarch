#!/usr/bin/env npx tsx
/**
 * e2e step: fund the escrow on Base Sepolia for a chain. Opens the agreement (client
 * = deployer) and deposits USDC earmarked to each agent's owner (the beneficiary the
 * verdict/refund logic resolves against). agreementId == chainId.
 *
 * Usage (from synarch/scripts):
 *   npx tsx e2e-fund.ts <chainId> [amountPerAgentUSDC]
 *
 * Needs the deployer to hold testnet USDC on Base Sepolia (default 1 USDC x 3 = 3).
 */
import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { AGENTS, AGENT_IDS, ESCROW, USDC, genlayer } from './e2e-common.js';

const CHAIN_ID = process.argv[2];
const amtArg = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '1';
const AMOUNT = parseUnits(amtArg, 6); // USDC per agent, 6 decimals
// Optional distinct escrow client. When set (and != depositor), a fault verdict pays
// the honest agents and withholds only the culpable one, instead of the client (as
// depositor) recovering everything. Use it for the visible "culpable at 0" split.
const clientFlag = process.argv.indexOf('--client');
const CLIENT_OVERRIDE = clientFlag >= 0 ? (process.argv[clientFlag + 1] as `0x${string}`) : undefined;

const ESCROW_ABI = [
  { type: 'function', name: 'openAgreement', stateMutability: 'nonpayable', inputs: [{ type: 'string' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'string' }, { type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getAgreement', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [
    { name: 'exists', type: 'bool' }, { name: 'settled', type: 'bool' }, { name: 'client', type: 'address' },
    { name: 'verdict', type: 'string' }, { name: 'culpableAgent', type: 'address' }, { name: 'total', type: 'uint256' }, { name: 'depositCount', type: 'uint256' },
  ] },
] as const;
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHAIN_ID) throw new Error('Usage: npx tsx e2e-fund.ts <chainId> [amountPerAgentUSDC]');
  const pk = (process.env.PRIVATE_KEY!.startsWith('0x') ? process.env.PRIVATE_KEY! : `0x${process.env.PRIVATE_KEY}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ chain: baseSepolia, transport: http() });
  const wallet = createWalletClient({ chain: baseSepolia, transport: http(), account });

  // Beneficiaries = each agent's owner (what the verdict/refund resolves against).
  const { read } = genlayer();
  const owners: string[] = [];
  for (const id of AGENT_IDS) {
    const p: any = await read(AGENTS, 'get_profile', [id]);
    owners.push(p.owner);
  }
  const total = AMOUNT * BigInt(AGENT_IDS.length);
  const escrowClient = (CLIENT_OVERRIDE || account.address) as `0x${string}`;

  console.log('Funding escrow', ESCROW);
  console.log('  agreementId :', CHAIN_ID);
  console.log('  depositor   :', account.address);
  console.log('  client      :', escrowClient, escrowClient.toLowerCase() === account.address.toLowerCase() ? '(same as depositor: fault -> client recovers all)' : '(distinct: fault -> honest agents paid, culpable withheld)');
  console.log('  per agent   :', formatUnits(AMOUNT, 6), 'USDC ->', owners.join(', '));
  console.log('  total       :', formatUnits(total, 6), 'USDC');

  const bal = (await pub.readContract({ address: USDC as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] })) as bigint;
  if (bal < total) throw new Error(`Insufficient USDC: have ${formatUnits(bal, 6)}, need ${formatUnits(total, 6)} on Base Sepolia`);

  const ag: any = await pub.readContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'getAgreement', args: [CHAIN_ID] });
  const have = ag[0] ? Number(ag[6]) : 0;
  if (!ag[0]) {
    console.log('\n  openAgreement...');
    const h = await wallet.writeContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'openAgreement', args: [CHAIN_ID, escrowClient] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error('openAgreement reverted: ' + h);
    console.log('    ok', h);
  } else {
    console.log('\n  agreement already open (depositCount=' + have + ')');
  }

  const need = AGENT_IDS.length - have; // idempotent: only add the missing deposits
  if (need <= 0) {
    console.log('  already fully funded (' + have + ' deposits).');
  } else {
    const wantAllowance = AMOUNT * BigInt(need);
    console.log(`  approve USDC (${formatUnits(wantAllowance, 6)} for ${need} more deposit(s))...`);
    const ah = await wallet.writeContract({ address: USDC as `0x${string}`, abi: ERC20_ABI, functionName: 'approve', args: [ESCROW as `0x${string}`, wantAllowance] });
    const ar = await pub.waitForTransactionReceipt({ hash: ah });
    if (ar.status !== 'success') throw new Error('approve reverted: ' + ah);

    // Base's public RPC is load-balanced and lags: the node a deposit executes on may
    // not see the approve yet. Poll the allowance until it reflects before depositing.
    let allowance = 0n;
    for (let i = 0; i < 20; i++) {
      allowance = (await pub.readContract({ address: USDC as `0x${string}`, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ESCROW as `0x${string}`] })) as bigint;
      if (allowance >= wantAllowance) break;
      console.log(`    waiting for allowance to reflect (${formatUnits(allowance, 6)}/${formatUnits(wantAllowance, 6)})...`);
      await sleep(3000);
    }
    if (allowance < AMOUNT) throw new Error('approve did not reflect on-chain; re-run e2e-fund');

    for (let j = 0; j < need; j++) {
      const idx = have + j;
      console.log(`  deposit ${AGENT_IDS[idx]} -> ${owners[idx]} : ${formatUnits(AMOUNT, 6)} USDC`);
      let ok = false;
      for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
        try {
          const dh = await wallet.writeContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'deposit', args: [CHAIN_ID, owners[idx] as `0x${string}`, AMOUNT] });
          const dr = await pub.waitForTransactionReceipt({ hash: dh });
          if (dr.status !== 'success') throw new Error('deposit tx reverted: ' + dh);
          ok = true;
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (/allowance|exceeds|lag|timeout|reverted/i.test(msg) && attempt < 5) {
            console.log(`    (deposit retry ${attempt}: ${msg.slice(0, 60)})`);
            await sleep(4000);
            continue;
          }
          throw e;
        }
      }
    }
  }

  const after: any = await pub.readContract({ address: ESCROW as `0x${string}`, abi: ESCROW_ABI, functionName: 'getAgreement', args: [CHAIN_ID] });
  console.log('\n  escrow total for', CHAIN_ID, '=', formatUnits(after[5], 6), 'USDC, deposits =', after[6].toString());
  console.log('\nFunded. Now run the chain / dispute, or test a refund.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\ne2e-fund failed:', e);
  process.exit(1);
});
