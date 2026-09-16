import { createClient } from 'genlayer-js';
import { TransactionStatus } from 'genlayer-js/types';
import { genlayerChain, GENLAYER_RPC } from './wagmi';
import { AGENTS_ADDRESS, JUDGE_ADDRESS } from '../constants';

// A read-only client (no account) for views; a provider-backed client (account +
// window.ethereum) for writes. The wallet must be on the GenLayer chain before a write.
function client(account?: `0x${string}`) {
  return createClient({
    chain: genlayerChain as any,
    endpoint: GENLAYER_RPC,
    account,
    provider: account ? (window as any).ethereum : undefined,
  });
}

// The node pushes back in several ways, all of them transient: -32005 ("at capacity"),
// -32006 ("all execution slots occupied"), a hard cap of 30 requests per minute, and the
// occasional HTML gateway page instead of JSON. None of these is a failed action, so they
// are waited out rather than surfaced: a user who clicks a button should not be shown
// "rate limit exceeded", they should just wait a moment longer.
// viem wraps an RPC error and puts its own headline in `message` ("Version of JSON-RPC
// protocol is not supported"), pushing the real cause into `details`/`shortMessage`/`cause`.
// Reading only `message` therefore misses exactly the errors worth retrying, so every text
// field is flattened into one haystack before matching.
function errorText(err: any): string {
  const parts = [
    err?.message, err?.shortMessage, err?.details, err?.reason,
    err?.cause?.message, err?.cause?.shortMessage, err?.cause?.details,
    err?.error?.message, err?.data?.message,
  ];
  return parts.filter(Boolean).join(' | ').toLowerCase();
}

function isTransient(err: any): boolean {
  const codes = [err?.code, err?.cause?.code, err?.error?.code, err?.data?.code, err?.cause?.cause?.code];
  if (codes.some((c) => c === -32005 || c === -32006)) return true;
  const msg = errorText(err);
  // Node backpressure (codes, rate limit, an HTML gateway page) AND plain network failures.
  // "Failed to fetch" is not an RPC answer at all: the request never completed, which is
  // the most transient thing that can happen and used to surface as a hard error.
  return /-32005|-32006|at capacity|slots occupied|busy|rate limit|too many requests|not valid json|doctype/.test(msg)
    || /failed to fetch|fetch failed|network ?error|networkerror|load failed|connection|econnreset|socket hang up|timed out|timeout/.test(msg);
}

// A rate limit is counted per minute, so backing off by a couple of seconds just burns
// another request. These wait long enough for the window itself to roll over.
function isRateLimit(err: any): boolean {
  return /rate limit|too many requests/.test(errorText(err));
}

/** The node is executing at capacity: retrying is right, but it needs room to drain. */
function isNodeBusy(err: any): boolean {
  return /slots occupied|at capacity|server busy/.test(errorText(err));
}

// A retry that nobody can see looks like a frozen app. Anything waiting on the node can
// publish what it is doing here, so the UI can say "node busy, retrying" instead of
// showing a dead button for minutes.
let retryListener: ((message: string) => void) | null = null;
export function onRpcRetry(fn: ((message: string) => void) | null) { retryListener = fn; }

async function withRpcRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      if (attempt > 0) retryListener?.('');
      return out;
    } catch (err) {
      if (!isTransient(err) || attempt >= maxRetries) { retryListener?.(''); throw err; }
      // The rate limit is counted per minute, so a 2s backoff just burns another request.
      // It still has to stay short enough that a user waiting to sign does not think the
      // app died: worst case here is about 40s, not the four minutes a 45s ceiling gave.
      const wait = isRateLimit(err) || isNodeBusy(err)
        ? Math.min(6000 + 4000 * attempt, 15000)
        : Math.min(1200 * 2 ** attempt, 8000) + 200;
      retryListener?.(
        isRateLimit(err)
          ? `Node at its request limit, retrying in ${Math.round(wait / 1000)}s...`
          : isNodeBusy(err)
            ? `Node is at full capacity, retrying in ${Math.round(wait / 1000)}s...`
            : `Node did not answer, retrying in ${Math.round(wait / 1000)}s...`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ---------------- Types ----------------
export interface AgentProfile {
  agentId: string;
  owner: string;
  role: string;
  persona: string;
  taskTemplate: string;
  criteria: string;
  configured: boolean;
  reliabilityPct?: number;
  participated?: number;
  culpable?: number;
}
export interface ChainStep { agentId: string; role: string; agentAddr: string; delivered: string; }
export interface Chain {
  chainId: string;
  agreement: string;
  client: string;
  status: string; // open | complete | cancelled (contract-level)
  plan: string[];
  steps: ChainStep[];
  stepsDone: number;
  stepsTotal: number;
}
export interface Reputation { agent: string; participated: number; culpable: number; reliabilityPct: number; }
export interface Verdict { status: string; verdict: string; culpableAgents: string[]; reason: string; }
export interface ExportForJudge { agreement: string; roles: string[]; agents: string[]; delivered: string[]; status: string; }

// ---------------- Reads ----------------
const read = (address: string, fn: string, args: any[] = []) =>
  withRpcRetry(() => client().readContract({ address: address as `0x${string}`, functionName: fn, args }));

export async function fetchAgentIds(): Promise<string[]> {
  return (await read(AGENTS_ADDRESS, 'get_agent_ids')) as string[];
}

export async function fetchReputation(agent: string): Promise<Reputation> {
  const r = (await read(JUDGE_ADDRESS, 'get_reputation', [agent])) as any;
  return { agent: r.agent, participated: Number(r.participated), culpable: Number(r.culpable), reliabilityPct: Number(r.reliability_pct) };
}

export async function fetchLeaderboard(): Promise<Reputation[]> {
  const board = (await read(JUDGE_ADDRESS, 'get_leaderboard')) as any[];
  return board.map((r) => ({ agent: r.agent, participated: Number(r.participated), culpable: Number(r.culpable), reliabilityPct: Number(r.reliability_pct) }));
}

/** All agents with their profile and (reputation keyed by owner) merged in.
 *
 *  Every call here is a gen_call the node executes, at 250ms to 1s each, so the shape of
 *  the fetch is what determines how fast the UI fills. Two things keep it short: the
 *  profiles are requested in parallel rather than one per agent in sequence, and the
 *  reputations come from ONE get_leaderboard instead of a get_reputation per agent.
 *  Pass `board` (or its promise) when the caller already asked for the leaderboard, so it
 *  is not fetched twice.
 */
export async function fetchAgents(board?: Reputation[] | Promise<Reputation[]>): Promise<AgentProfile[]> {
  const [ids, reputations] = await Promise.all([
    fetchAgentIds(),
    Promise.resolve(board ?? fetchLeaderboard()).catch(() => [] as Reputation[]),
  ]);

  const repFor = (owner: string) =>
    reputations.find((r) => r.agent?.toLowerCase() === owner?.toLowerCase());

  const profiles = await Promise.all(
    ids.map((agentId) => read(AGENTS_ADDRESS, 'get_profile', [agentId]).then((p) => ({ agentId, p: p as any }))),
  );

  return profiles.map(({ agentId, p }) => {
    const profile: AgentProfile = {
      agentId,
      owner: p.owner,
      role: p.role,
      persona: p.persona,
      taskTemplate: p.task_template,
      criteria: p.criteria,
      configured: !!p.configured,
    };
    const rep = repFor(p.owner);
    if (rep) {
      profile.reliabilityPct = rep.reliabilityPct;
      profile.participated = rep.participated;
      profile.culpable = rep.culpable;
    }
    return profile;
  });
}

export async function fetchChainIds(): Promise<string[]> {
  return (await read(AGENTS_ADDRESS, 'get_chain_ids')) as string[];
}

export async function fetchChain(chainId: string): Promise<Chain> {
  const c = (await read(AGENTS_ADDRESS, 'get_chain', [chainId])) as any;
  return {
    chainId,
    agreement: c.agreement,
    client: c.client,
    status: c.status,
    plan: c.plan,
    steps: (c.steps || []).map((s: any) => ({ agentId: s.agent_id, role: s.role, agentAddr: s.agent_addr, delivered: s.delivered })),
    stepsDone: Number(c.steps_done),
    stepsTotal: Number(c.steps_total),
  };
}

export async function exportForJudge(chainId: string): Promise<ExportForJudge> {
  const e = (await read(AGENTS_ADDRESS, 'export_for_judge', [chainId])) as any;
  return { agreement: e.agreement, roles: e.roles, agents: e.agents, delivered: e.delivered, status: e.status };
}

export async function previewPrompt(agentId: string, request: string): Promise<string> {
  return (await read(AGENTS_ADDRESS, 'preview_prompt', [agentId, request])) as string;
}

export async function fetchVerdict(chainId: string): Promise<Verdict> {
  const v = (await read(JUDGE_ADDRESS, 'get_verdict', [chainId])) as any;
  return { status: v.status, verdict: v.verdict, culpableAgents: Array.isArray(v.culpable_agents) ? v.culpable_agents.map(String) : [], reason: v.reason || '' };
}

/** Every ruling the judge has issued, newest first. This is the evidence behind every
 *  reputation number: the score is derived from these verdicts and from nothing else, so
 *  showing the percentages without them asks the user to take the math on faith.
 */
export interface Ruling {
  chainId: string;
  verdict: string;
  culpableAgents: string[];
  reason: string;
}

export async function fetchRulings(limit = 12): Promise<Ruling[]> {
  try {
    const ids = (await fetchDisputeIds()).slice(-limit).reverse();
    const rulings = await Promise.all(
      ids.map(async (chainId) => {
        try {
          const v = await fetchVerdict(chainId);
          if (v.status !== 'judged') return null;
          return { chainId, verdict: v.verdict, culpableAgents: v.culpableAgents, reason: v.reason };
        } catch { return null; }
      }),
    );
    return rulings.filter(Boolean) as Ruling[];
  } catch {
    return [];
  }
}

/** Hashes of the successful run_next_step calls for a chain, in execution order, read from
 *  the NODE. All four steps share the same calldata (method + chain id), so they cannot be
 *  told apart by content; they are ordered by creation time instead, which makes the Nth
 *  hash the Nth step. Failed attempts are skipped so a retried step does not shift the map.
 */
export async function fetchStepTxs(chainId: string): Promise<string[]> {
  try {
    const res = await withRpcRetry(() =>
      fetch(GENLAYER_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sim_getTransactionsForAddress',
          params: [AGENTS_ADDRESS],
        }),
      }).then((r) => r.json()),
    );
    const txs: any[] = (res as any)?.result ?? [];
    return txs
      .filter((tx) => {
        const b64 = tx?.data?.calldata;
        if (typeof b64 !== 'string') return false;
        let raw = '';
        try { raw = atob(b64); } catch { return false; }
        return raw.includes('run_next_step') && raw.includes(chainId)
          && (!tx.txExecutionResultName || tx.txExecutionResultName === 'FINISHED_WITH_RETURN');
      })
      .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime())
      .map((tx) => tx.hash as string);
  } catch {
    return [];
  }
}

/** The transaction that authorised a client refund (cancel or timeout), read from the NODE.
 *  It lives on the AGENTS contract, not the judge: refunds are authorised where the chain
 *  state is, and only then dispatched to the escrow. */
export async function fetchRefundTx(chainId: string): Promise<string | null> {
  try {
    const res = await withRpcRetry(() =>
      fetch(GENLAYER_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sim_getTransactionsForAddress',
          params: [AGENTS_ADDRESS],
        }),
      }).then((r) => r.json()),
    );
    const txs: any[] = (res as any)?.result ?? [];
    for (const tx of txs.slice().reverse()) {
      const b64 = tx?.data?.calldata;
      if (typeof b64 !== 'string') continue;
      let raw = '';
      try { raw = atob(b64); } catch { continue; }
      if (!raw.includes(chainId)) continue;
      if (tx.txExecutionResultName && tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') continue;
      if (raw.includes('cancel_chain') || raw.includes('claim_timeout')) return tx.hash as string;
    }
    return null;
  } catch {
    return null;
  }
}

/** The judge transactions that produced and dispatched a verdict, read from the NODE.
 *  The local tx store only holds what this browser signed, so it is empty after a cache
 *  clear or on another machine; the chain always has the record.
 *
 *  sim_getTransactionsForAddress returns the contract's transactions with their calldata
 *  base64-encoded. That payload embeds the method name and the string arguments as plain
 *  ASCII, so a decoded-substring match identifies the call without a full calldata decode.
 */
export interface VerdictProof { judged?: string; dispatched?: string }

export async function fetchVerdictProof(chainId: string): Promise<VerdictProof> {
  try {
    const res = await withRpcRetry(() =>
      fetch(GENLAYER_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sim_getTransactionsForAddress',
          params: [JUDGE_ADDRESS],
        }),
      }).then((r) => r.json()),
    );
    const txs: any[] = (res as any)?.result ?? [];
    const proof: VerdictProof = {};
    // Oldest first, so a retried call leaves the LAST successful hash in place.
    for (const tx of txs.slice().reverse()) {
      const b64 = tx?.data?.calldata;
      if (typeof b64 !== 'string') continue;
      let raw = '';
      try { raw = atob(b64); } catch { continue; }
      if (!raw.includes(chainId)) continue;
      if (tx.txExecutionResultName && tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') continue;
      if (raw.includes('judge_dispute')) proof.judged = tx.hash;
      else if (raw.includes('dispatch_verdict')) proof.dispatched = tx.hash;
    }
    return proof;
  } catch {
    return {};
  }
}

export async function fetchDisputeIds(): Promise<string[]> {
  return (await read(JUDGE_ADDRESS, 'get_dispute_ids')) as string[];
}

// ---------------- Writes (need the wallet on the GenLayer chain) ----------------

// genlayer-js 2.x rejects a write with no fees attached (FeeValueMustBeNonZero), so every
// write carries an estimate, and the estimate has to be made PER CALL. A method that emits
// a cross-chain message (dispatch_verdict, the refunds) must declare that message in
// messageAllocations; a generic estimate returns none and the VM rejects the transaction
// with `fee no_matching_allocation`, which is what broke Settle verdict. This variant
// simulates the real call and derives the allocations it needs.
async function writeFees(c: any, address: string, fn: string, args: any[]) {
  const est: any = await withRpcRetry<any>(() =>
    c.estimateTransactionFeesForWrite({ address: address as `0x${string}`, functionName: fn, args }),
  );
  const fees: any = { distribution: est.distribution, feeValue: est.feeValue };
  if (est.messageAllocations?.length) fees.messageAllocations = est.messageAllocations;
  return fees;
}

async function write(account: `0x${string}`, address: string, fn: string, args: any[]): Promise<string> {
  const c = client(account);
  const fees = await writeFees(c, address, fn, args);
  const hash = await withRpcRetry(() => c.writeContract({ address: address as `0x${string}`, functionName: fn, args, value: 0n, fees: fees as any }));
  await c.waitForTransactionReceipt({ hash: hash as any, status: TransactionStatus.ACCEPTED, retries: 60, interval: 5000 });
  return hash as string;
}

export const openChain = (account: `0x${string}`, chainId: string, agreement: string, clientAddr: string, agentIds: string[]) =>
  write(account, AGENTS_ADDRESS, 'open_chain', [chainId, agreement, clientAddr, agentIds]);

export const runNextStep = (account: `0x${string}`, chainId: string) =>
  write(account, AGENTS_ADDRESS, 'run_next_step', [chainId]);

export const cancelChain = (account: `0x${string}`, chainId: string) =>
  write(account, AGENTS_ADDRESS, 'cancel_chain', [chainId]);

export const claimTimeout = (account: `0x${string}`, chainId: string) =>
  write(account, AGENTS_ADDRESS, 'claim_timeout', [chainId]);

export const submitChainDispute = (account: `0x${string}`, chainId: string, e: ExportForJudge, evidenceUrl = '') =>
  write(account, JUDGE_ADDRESS, 'submit_chain_dispute', [
    chainId, e.agreement, e.roles, e.agents, e.delivered,
    'client disputes the final result', 'client disputes the final result', evidenceUrl,
  ]);

export const judgeDispute = (account: `0x${string}`, chainId: string) =>
  write(account, JUDGE_ADDRESS, 'judge_dispute', [chainId]);

export const dispatchVerdict = (account: `0x${string}`, chainId: string) =>
  write(account, JUDGE_ADDRESS, 'dispatch_verdict', [chainId]);
