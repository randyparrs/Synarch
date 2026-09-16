import { writeContract, waitForTransactionReceipt, switchChain, readContract } from '@wagmi/core';
import { parseUnits, createPublicClient, parseAbiItem } from 'viem';
import { wagmiConfig, baseSepolia, baseTransport } from './wagmi';
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
// `chain` is what carries the Multicall3 address, so it is required for the batched
// reads below; the transport is the shared two-node fallback.
const basePublic = createPublicClient({ chain: baseSepolia, transport: baseTransport });
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
// An agreement that is still open has no settlement to find, but the sweep below cost 40
// getLogs before concluding that. A miss is remembered for a minute too, so re-selecting a
// workflow does not re-run the whole search against the public nodes.
const missCache = new Map<string, number>();
const MISS_TTL = 60_000;

export async function getSettlementTx(chainId: string): Promise<`0x${string}` | null> {
  try {
    const cached = localStorage.getItem(cacheKey(chainId));
    if (cached) return cached as `0x${string}`;
  } catch { /* private mode: just search again */ }

  const missedAt = missCache.get(chainId);
  if (missedAt && Date.now() - missedAt < MISS_TTL) return null;

  try {
    // One cheap read decides whether the expensive one is worth making at all.
    const ag = await getAgreement(chainId);
    if (!ag.exists || !ag.settled) { missCache.set(chainId, Date.now()); return null; }

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
    missCache.set(chainId, Date.now());
    return null;
  } catch {
    missCache.set(chainId, Date.now());
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

  // Walking this one agreement at a time meant an agreement read plus a read per deposit,
  // all sequential: around a hundred round trips every time the Reputation tab opened, which
  // is exactly what a shared public node answers with a rate limit. It is now two batched
  // requests: every agreement, then every deposit of the settled ones.
  try {
    const ids = (await getAgreementIds()).slice(-maxAgreements);
    if (ids.length === 0) return [];

    const agreements = (await basePublic.multicall({
      contracts: ids.map((id) => ({
        address: escrow, abi: ESCROW_ABI, functionName: 'getAgreement', args: [id],
      })),
      allowFailure: true,
    })) as any[];

    const settled = ids
      .map((id, i) => ({ id, row: agreements[i] }))
      .filter(({ row }) => row?.status === 'success' && row.result?.[0] && row.result?.[1])
      .map(({ id, row }) => ({
        id,
        ag: {
          exists: row.result[0], settled: row.result[1], client: row.result[2],
          verdict: row.result[3], culpableAgents: (row.result[4] as string[]) ?? [],
          total: row.result[5] as bigint, depositCount: Number(row.result[6]),
        } as Agreement,
      }));

    // Every deposit of every settled agreement, flattened into one request. Each slot keeps
    // its agreement so the outcome is resolved against the right verdict.
    const slots = settled.flatMap(({ id, ag }) =>
      Array.from({ length: ag.depositCount }, (_, i) => ({
        ag,
        call: { address: escrow, abi: ESCROW_ABI, functionName: 'getDeposit', args: [id, BigInt(i)] },
      })));
    if (slots.length === 0) return [];

    const rows = (await basePublic.multicall({
      contracts: slots.map((slot) => slot.call),
      allowFailure: true,
    })) as any[];

    slots.forEach((slot, i) => {
      const row = rows[i];
      if (row?.status !== 'success') return;
      const beneficiary = row.result[1] as string;
      const amount = row.result[2] as bigint;
      const out = depositOutcome(slot.ag, beneficiary);
      if (out.kind === 'paid') bump(beneficiary, 'earned', amount);
      else if (out.kind === 'withheld') bump(beneficiary, 'withheld', amount);
      else if (out.kind === 'refunded') bump(beneficiary, 'refunded', amount);
    });
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
/** Every deposit of an agreement in ONE request. This is polled every 20 seconds by two
 *  different views, so asking for the deposits one at a time meant four sequential round
 *  trips per tick, per open tab; Multicall3 folds them into a single call. */
export async function getDeposits(chainId: string, count: number): Promise<DepositRow[]> {
  if (count <= 0) return [];
  const rows = (await basePublic.multicall({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: escrow, abi: ESCROW_ABI, functionName: 'getDeposit', args: [chainId, BigInt(i)],
    })),
    allowFailure: false,
  })) as any[];
  return rows.map((r) => ({ depositor: r[0], beneficiary: r[1], amount: r[2] as bigint }));
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
