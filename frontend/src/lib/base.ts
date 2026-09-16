import { writeContract, waitForTransactionReceipt, switchChain, readContract } from '@wagmi/core';
import { parseUnits, createPublicClient, http, parseAbiItem } from 'viem';
import { wagmiConfig, baseSepolia } from './wagmi';
import { ESCROW_ADDRESS, USDC_ADDRESS, ESCROW_ABI, ERC20_ABI } from '../constants';

const escrow = ESCROW_ADDRESS as `0x${string}`;
const usdc = USDC_ADDRESS as `0x${string}`;

export interface Agreement {
  exists: boolean; settled: boolean; client: string; verdict: string;
  culpableAgents: string[]; total: bigint; depositCount: number;
}
export interface DepositRow { depositor: string; beneficiary: string; amount: bigint; }

/** What actually happened to one deposit, resolved the way the escrow itself resolves it.
 *  Single source of truth: every view that shows a per-deposit status reads this, so the
 *  slot cards, the overview ledger and the deposit log cannot disagree with each other.
 *
 *  `refundCrossing` is the GenLayer-side fact that a refund was authorised but has not yet
 *  reached Base, which the escrow alone cannot know.
 */
export type DepositOutcome =
  | { kind: 'locked'; label: 'LOCKED'; note: string }
  | { kind: 'refunding'; label: 'REFUNDING'; note: string }
  | { kind: 'refunded'; label: 'REFUNDED'; note: string }
  | { kind: 'withheld'; label: 'WITHHELD'; note: string }
  | { kind: 'paid'; label: 'PAID'; note: string };

export function depositOutcome(
  ag: Agreement | null | undefined,
  beneficiary: string,
  refundCrossing = false,
): DepositOutcome {
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  if (!ag?.settled) {
    return refundCrossing
      ? { kind: 'refunding', label: 'REFUNDING', note: 'refund crossing to Base' }
      : { kind: 'locked', label: 'LOCKED', note: 'held in escrow' };
  }
  // A refund returns every share to whoever deposited it: nobody was paid for work.
  if (ag.verdict === 'REFUNDED') {
    return { kind: 'refunded', label: 'REFUNDED', note: 'returned to depositor' };
  }
  if (ag.culpableAgents?.some((c) => same(c, beneficiary))) {
    return { kind: 'withheld', label: 'WITHHELD', note: 'withheld, sent to the client' };
  }
  return { kind: 'paid', label: 'PAID', note: 'paid to agent' };
}

// Every payout of a settlement happens inside ONE transaction: processBridgeMessage loops
// the deposits and transfers each share, so there is a single settlement hash for the whole
// split, not one per agent. That transaction is sent by the bridge receiver, never by the
// user, so it is not in this browser's tx store and has to be read from chain logs.
const basePublic = createPublicClient({ transport: http('https://sepolia.base.org') });
const SETTLED_EVENT = parseAbiItem(
  'event AgreementSettled(string indexed agreementId, string verdict, address[] culpableAgents, uint256 total)',
);
const REFUNDED_EVENT = parseAbiItem(
  'event AgreementRefunded(string indexed agreementId, uint256 action, uint256 total)',
);
// The public Base RPC rejects wide getLogs ranges: 20k blocks fails, 5k works. So the search
// is chunked, and it starts from the block the agreement was FUNDED at rather than from a
// blind window, since a settlement can only happen after its funding. Base produces a block
// about every 2 seconds, which turns the stored fundedAt timestamp into a block estimate.
const LOG_CHUNK = 4500n;
const MAX_CHUNKS = 20; // ~50 hours of blocks, enough for any demo-age agreement
const BLOCK_SECONDS = 2n;
const cacheKey = (chainId: string) => `synarch.settletx.${chainId}`;

/** Transaction hash of the settlement (or refund) that paid out this agreement, read from
 *  Base logs. Cached once found: the hash is immutable, so it never needs a second search.
 *  Null when the agreement is older than the search span or the RPC refuses. */
export async function getSettlementTx(chainId: string): Promise<`0x${string}` | null> {
  try {
    const cached = localStorage.getItem(cacheKey(chainId));
    if (cached) return cached as `0x${string}`;
  } catch { /* private mode: just search again */ }

  try {
    const latest = await basePublic.getBlockNumber();
    const funded = await fundedAt(chainId);
    const now = BigInt(Math.floor(Date.now() / 1000));
    let from = funded > 0n && now > funded
      ? latest - (now - funded) / BLOCK_SECONDS
      : latest - LOG_CHUNK;
    if (from < 0n) from = 0n;

    for (let i = 0; i < MAX_CHUNKS && from <= latest; i++) {
      const to = from + LOG_CHUNK > latest ? latest : from + LOG_CHUNK;
      for (const event of [SETTLED_EVENT, REFUNDED_EVENT]) {
        const logs = await basePublic.getLogs({
          address: escrow, event: event as any,
          args: { agreementId: chainId } as any,
          fromBlock: from, toBlock: to,
        });
        if (logs.length) {
          const hash = logs[logs.length - 1].transactionHash;
          try { localStorage.setItem(cacheKey(chainId), hash); } catch { /* ignore */ }
          return hash;
        }
      }
      from = to + 1n;
    }
    return null;
  } catch {
    return null; // an RPC hiccup must not break the ledger
  }
}

/** What each agent has actually earned, lost and had returned across every settled
 *  agreement. Reputation says how often an agent was blamed; this says what that cost it,
 *  which is the point of the whole system: a score with money behind it.
 */
export interface AgentEarnings { beneficiary: string; earned: bigint; withheld: bigint; refunded: bigint; jobs: number }

export async function fetchAgentEarnings(maxAgreements = 20): Promise<AgentEarnings[]> {
  const totals = new Map<string, AgentEarnings>();
  const bump = (who: string, field: 'earned' | 'withheld' | 'refunded', amount: bigint) => {
    const key = who.toLowerCase();
    const row = totals.get(key) ?? { beneficiary: key, earned: 0n, withheld: 0n, refunded: 0n, jobs: 0 };
    row[field] += amount;
    row.jobs += 1;
    totals.set(key, row);
  };

  try {
    const ids = (await getAgreementIds()).slice(-maxAgreements);
    for (const id of ids) {
      const ag = await getAgreement(id);
      if (!ag.exists || !ag.settled) continue; // only money that actually moved
      const deposits = await getDeposits(id, ag.depositCount);
      for (const d of deposits) {
        const out = depositOutcome(ag, d.beneficiary);
        if (out.kind === 'paid') bump(d.beneficiary, 'earned', d.amount);
        else if (out.kind === 'withheld') bump(d.beneficiary, 'withheld', d.amount);
        else if (out.kind === 'refunded') bump(d.beneficiary, 'refunded', d.amount);
      }
    }
  } catch { /* partial totals are still worth showing */ }

  return [...totals.values()];
}

/** USDC has 6 decimals; convert a human "0.25" amount to raw units. */
export const usdcRaw = (amount: string): bigint => parseUnits((amount || '0') as `${number}`, 6);

/** Move the connected wallet to Base Sepolia so escrow/USDC txs sign on the right chain. */
export async function switchToBase(): Promise<void> {
  await switchChain(wagmiConfig, { chainId: baseSepolia.id });
}

// ---------------- Reads ----------------
export async function getAgreement(chainId: string): Promise<Agreement> {
  const r = (await readContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'getAgreement', args: [chainId], chainId: baseSepolia.id })) as any;
  return { exists: r[0], settled: r[1], client: r[2], verdict: r[3], culpableAgents: (r[4] as string[]) ?? [], total: r[5] as bigint, depositCount: Number(r[6]) };
}
export async function getAgreementIds(): Promise<string[]> {
  return (await readContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'getAgreementIds', chainId: baseSepolia.id })) as string[];
}
export async function getDeposit(chainId: string, index: number): Promise<DepositRow> {
  const r = (await readContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'getDeposit', args: [chainId, BigInt(index)], chainId: baseSepolia.id })) as any;
  return { depositor: r[0], beneficiary: r[1], amount: r[2] as bigint };
}
export async function getDeposits(chainId: string, count: number): Promise<DepositRow[]> {
  const out: DepositRow[] = [];
  for (let i = 0; i < count; i++) out.push(await getDeposit(chainId, i));
  return out;
}
export async function escrowBalance(): Promise<bigint> {
  return (await readContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'balance', chainId: baseSepolia.id })) as bigint;
}
export async function fundedAt(chainId: string): Promise<bigint> {
  return (await readContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'fundedAt', args: [chainId], chainId: baseSepolia.id })) as bigint;
}
export async function refundTimeout(): Promise<bigint> {
  return (await readContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'refundTimeout', chainId: baseSepolia.id })) as bigint;
}
export async function usdcAllowance(owner: `0x${string}`): Promise<bigint> {
  return (await readContract(wagmiConfig, { address: usdc, abi: ERC20_ABI, functionName: 'allowance', args: [owner, escrow], chainId: baseSepolia.id })) as bigint;
}
export async function usdcBalanceOf(owner: `0x${string}`): Promise<bigint> {
  return (await readContract(wagmiConfig, { address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner], chainId: baseSepolia.id })) as bigint;
}

// ---------------- Writes ----------------
export async function approveUsdc(amount: bigint): Promise<`0x${string}`> {
  const hash = await writeContract(wagmiConfig, { address: usdc, abi: ERC20_ABI, functionName: 'approve', args: [escrow, amount], chainId: baseSepolia.id });
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId: baseSepolia.id });
  return hash;
}
export async function openAgreement(chainId: string, client: `0x${string}`): Promise<`0x${string}`> {
  const hash = await writeContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'openAgreement', args: [chainId, client], chainId: baseSepolia.id });
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId: baseSepolia.id });
  return hash;
}
export async function deposit(chainId: string, beneficiary: `0x${string}`, amount: bigint): Promise<`0x${string}`> {
  const hash = await writeContract(wagmiConfig, { address: escrow, abi: ESCROW_ABI, functionName: 'deposit', args: [chainId, beneficiary, amount], chainId: baseSepolia.id });
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId: baseSepolia.id });
  return hash;
}
