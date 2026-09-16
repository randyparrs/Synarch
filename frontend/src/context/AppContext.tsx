import { createContext, useContext, useCallback, useEffect, useMemo, useState, ReactNode } from 'react';
import { fetchAgents, fetchChainIds, fetchLeaderboard, AgentProfile, Reputation } from '../lib/genlayer';
import { isProdAgent, isVisibleChain } from '../constants';

export type View = 'overview' | 'agents' | 'workflows' | 'escrow' | 'reputation' | 'how';

// When the user asks to open a specific chain from Workflows, we jump to
// Overview and preselect it through this value.
export interface FocusChain { chainId: string; at: number; }

// A signed transaction, captured the moment the frontend submits it, so the UI
// can show its real hash + explorer link as proof it happened on-chain.
// `ref` optionally ties the tx to a specific agent (e.g. the agent a run/deposit
// belongs to) so per-row/per-card hash links can find their tx.
export interface TxEntry { chainId: string; kind: string; label: string; network: 'genlayer' | 'base'; hash: string; at: number; ref?: string; }

const TX_STORE_KEY = 'synarch-tx-v1';

// Last known agents and workflow ids, kept so a reload paints the UI immediately instead of
// showing zeros while the node answers. It is a CACHE, never the source of truth: a fresh
// read replaces it as soon as it lands, a few hundred ms later.
const SNAPSHOT_KEY = 'synarch-snapshot-v1';
function readSnapshot<T>(field: 'agents' | 'chainIds', fallback: T): T {
  try {
    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
    return (snap?.[field] as T) ?? fallback;
  } catch { return fallback; }
}
function writeSnapshot(field: 'agents' | 'chainIds', value: unknown) {
  try {
    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
    snap[field] = value;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* private mode: the app just loads from the node as before */ }
}
function loadTxStore(): Record<string, TxEntry[]> {
  try { return JSON.parse(localStorage.getItem(TX_STORE_KEY) || '{}'); } catch { return {}; }
}

interface AppState {
  view: View;
  setView: (v: View) => void;

  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;

  // All agents from get_agent_ids(), and the production subset (-mo only) that
  // every tab must render. Never hardcode the ids: this is the single source.
  agents: AgentProfile[];
  prodAgents: AgentProfile[];
  agentsLoading: boolean;
  reloadAgents: () => Promise<void>;
  refreshAgentsAndReputation: () => Promise<void>;

  leaderboard: Reputation[];
  reloadLeaderboard: () => Promise<void>;

  chainIds: string[];
  reloadChainIds: () => Promise<void>;

  // Cross-view: "Open in Overview" from a workflow row.
  focusChain: FocusChain | null;
  openChainInOverview: (chainId: string) => void;

  // On-chain tx proof, keyed by chainId, captured as the user signs.
  txByChain: Record<string, TxEntry[]>;
  recordTx: (e: Omit<TxEntry, 'at'>) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('overview');
  const [createOpen, setCreateOpen] = useState(false);
  const [focusChain, setFocusChain] = useState<FocusChain | null>(null);

  const [agents, setAgents] = useState<AgentProfile[]>(() => readSnapshot<AgentProfile[]>('agents', []));
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Reputation[]>([]);
  const [chainIds, setChainIds] = useState<string[]>(() => readSnapshot<string[]>('chainIds', []));

  const prodAgents = useMemo(() => agents.filter((a) => isProdAgent(a.agentId)), [agents]);

  const [txByChain, setTxByChain] = useState<Record<string, TxEntry[]>>(loadTxStore);
  const recordTx = useCallback((e: Omit<TxEntry, 'at'>) => {
    if (!e.hash || !e.chainId) return;
    setTxByChain((prev) => {
      const list = prev[e.chainId] || [];
      if (list.some((x) => x.hash === e.hash)) return prev; // dedup
      const next = { ...prev, [e.chainId]: [...list, { ...e, at: Date.now() }] };
      try { localStorage.setItem(TX_STORE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  // Agents and leaderboard share ONE get_leaderboard call: the agent list needs the
  // reputations anyway, and every extra call costs a node round trip and a slice of the
  // 30-requests-per-minute budget.
  const reloadAgents = useCallback(async (board?: Promise<Reputation[]>) => {
    setAgentsLoading(true);
    try {
      const fresh = await fetchAgents(board);
      setAgents(fresh);
      // Only the STABLE half of an agent is cached: id, owner, role, prompts. Reputation is
      // volatile (a single verdict rewrites it) and caching it meant a failed refresh left
      // plausible but wrong percentages on screen, which is worse than showing nothing.
      writeSnapshot('agents', fresh.map(({ reliabilityPct, participated, culpable, ...stable }) => stable));
    } catch (e) { console.error('reloadAgents', e); } finally { setAgentsLoading(false); }
  }, []);

  const reloadLeaderboard = useCallback(async () => {
    try { setLeaderboard(await fetchLeaderboard()); } catch (e) { console.error('reloadLeaderboard', e); }
  }, []);

  // Agents and reputation always move together: a verdict updates both. One call to the
  // leaderboard feeds both, so refreshing them as a pair costs the same as refreshing one.
  const refreshAgentsAndReputation = useCallback(async () => {
    const board = fetchLeaderboard();
    board.then(setLeaderboard).catch((e) => console.error('reloadLeaderboard', e));
    await reloadAgents(board);
  }, [reloadAgents]);

  const reloadChainIds = useCallback(async () => {
    // Hide old e2e/test chains here so every consumer (Workflows, Overview
    // selector, nav count) only ever sees real user-created workflows.
    try {
      const fresh = (await fetchChainIds()).filter(isVisibleChain);
      setChainIds(fresh);
      writeSnapshot('chainIds', fresh);
    } catch (e) { console.error('reloadChainIds', e); }
  }, []);

  useEffect(() => {
    const board = fetchLeaderboard();
    board.then(setLeaderboard).catch((e) => console.error('reloadLeaderboard', e));
    reloadAgents(board);
    reloadChainIds();
  }, [reloadAgents, reloadChainIds]);

  const openChainInOverview = useCallback((chainId: string) => {
    setFocusChain({ chainId, at: Date.now() });
    setView('overview');
  }, []);

  return (
    <Ctx.Provider value={{
      view, setView,
      createOpen, openCreate: () => setCreateOpen(true), closeCreate: () => setCreateOpen(false),
      agents, prodAgents, agentsLoading, reloadAgents, refreshAgentsAndReputation,
      leaderboard, reloadLeaderboard,
      chainIds, reloadChainIds,
      focusChain, openChainInOverview,
      txByChain, recordTx,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp must be used within AppProvider');
  return c;
}
