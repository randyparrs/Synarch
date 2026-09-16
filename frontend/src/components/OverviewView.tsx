import { useCallback, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useApp } from '../context/AppContext';
import { useWallet } from '../hooks/useWallet';
import {
  fetchChain, fetchVerdict, exportForJudge, fetchDisputeIds,
  runNextStep, submitChainDispute, judgeDispute, dispatchVerdict, cancelChain,
  Chain, Verdict, fetchVerdictProof, fetchStepTxs, fetchRefundTx, onRpcRetry, VerdictProof,
} from '../lib/genlayer';
import { getAgreement, getDeposits, escrowBalance, getSettlementTx, depositOutcome, Agreement, DepositRow } from '../lib/base';
import { bridgeStatus, BridgeStatus } from '../lib/bridge';
import { truncateAddress, formatUsdc, txUrl } from '../constants';
import { TxHashLink } from './TxHashLink';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ArrowIcon = () => (<svg className="syn-icon" width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="m221.66 133.66-72 72a8 8 0 0 1-11.32-11.32L196.69 136H40a8 8 0 0 1 0-16h156.69l-58.35-58.34a8 8 0 0 1 11.32-11.32l72 72a8 8 0 0 1 0 11.32" /></svg>);

// Lightweight, injection-safe Markdown: **bold** inline + `-`/`*` bullet lists.
// Enough for the agent-output modal; builds React nodes (no dangerouslySetInnerHTML).
function renderInline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>);
}
function renderMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flush = () => { if (bullets.length) { out.push(<ul key={`ul${out.length}`} style={{ margin: '4px 0 10px', paddingLeft: 18 }}>{bullets}</ul>); bullets = []; } };
  (text || '').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (/^[-*]\s+/.test(t)) bullets.push(<li key={i} style={{ marginBottom: 4 }}>{renderInline(t.replace(/^[-*]\s+/, ''))}</li>);
    else { flush(); if (t) out.push(<p key={i} style={{ margin: '0 0 8px' }}>{renderInline(t)}</p>); }
  });
  flush();
  return out.length ? out : [<p key="empty" style={{ margin: 0, color: 'var(--color-neutral-600)' }}>No output yet.</p>];
}
const CloseIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z" /></svg>);

// One real step of the cross-chain settlement. State is derived from the settled
// poll, never a timer or an invented counter.
type PipeState = 'done' | 'active' | 'waiting' | 'pending' | 'cancelled';

/** A transaction hash as an explorer link. */
function TxLink({ hash, prefix, network = 'genlayer' }: { hash: string; prefix?: string; network?: 'genlayer' | 'base' }) {
  const url = txUrl(network, hash);
  const text = `${prefix ? `${prefix} ` : ''}${truncateAddress(hash)}`;
  if (!url) return <span className="syn-txlink" title={hash}>{text}</span>;
  return <a className="syn-txlink" href={url} target="_blank" rel="noopener noreferrer" title={hash}>{text} ↗</a>;
}

/** One line of on-chain proof: what happened, on which network, and the transaction. */
function ProofRow({ label, net, hash, network, last }: { label: string; net: string; hash?: string | null; network: 'genlayer' | 'base'; last?: boolean }) {
  const url = hash ? txUrl(network, hash) : null;
  return (
    <div className="syn-row" style={last ? { borderBottom: 0 } : undefined}>
      <span className="syn-row__kind">{label}</span>
      <span className={`syn-tag ${network === 'base' ? '' : 'syn-tag--done'}`} style={{ fontSize: 9 }}>{net}</span>
      {hash && url ? (
        <a className="syn-txlink" href={url} target="_blank" rel="noopener noreferrer" title={hash}>{truncateAddress(hash)} ↗</a>
      ) : (
        <span className="mono" style={{ fontSize: 10, color: 'var(--color-neutral-600)' }}>{hash ? truncateAddress(hash) : 'pending'}</span>
      )}
    </div>
  );
}

function SettleStep({ done, active, label }: { done: boolean; active?: boolean; label: string }) {
  const color = done ? 'var(--color-accent-300)' : active ? 'var(--syn-amber)' : 'var(--color-neutral-600)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 11.5, color }}>
      <span className="syn-pipe__dot" style={{ background: color }} />
      <span>{label}{done ? ' ✓' : ''}</span>
    </div>
  );
}

// A judge verdict is "decided" once the judge reports status == "judged" (a real
// ruling). NO_MAJORITY is the committee failing to converge, so the client re-sends
// (fresh committee); it is not a settleable verdict.
function disputeStage(v: Verdict | null): 'none' | 'no_majority' | 'decided' {
  if (!v || !v.status) return 'none';
  const s = v.status.toUpperCase();
  if (s.includes('NO_MAJORITY') || (v.verdict || '').toUpperCase() === 'NO_MAJORITY') return 'no_majority';
  if (s === 'JUDGED' || v.verdict) return 'decided';
  return 'none';
}

export function OverviewView() {
  const w = useWallet();
  const { chainIds, prodAgents, focusChain, reloadChainIds, recordTx, refreshAgentsAndReputation } = useApp();

  const [sel, setSel] = useState('');
  const [chain, setChain] = useState<Chain | null>(null);
  const [ag, setAg] = useState<Agreement | null>(null);
  const [deposits, setDeposits] = useState<DepositRow[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [escrowBal, setEscrowBal] = useState<bigint>(0n);
  const [disputes, setDisputes] = useState<number>(0);

  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [settleTx, setSettleTx] = useState<`0x${string}` | null>(null);
  const [proof, setProof] = useState<VerdictProof>({});
  const [stepTxs, setStepTxs] = useState<string[]>([]);
  const [refundTx, setRefundTx] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [outputModal, setOutputModal] = useState<{ agentId: string; index: number; state: string; deliverable: string; payout: bigint } | null>(null);
  const pollRef = useRef<number | null>(null);
  const judgePollRef = useRef<number | null>(null);

  // Default selection: focus chain from Workflows, else the latest chain.
  useEffect(() => {
    if (focusChain?.chainId) setSel(focusChain.chainId);
  }, [focusChain]);
  useEffect(() => {
    if (!sel && chainIds.length) setSel(chainIds[chainIds.length - 1]);
  }, [chainIds, sel]);

  // Global stats that do not depend on the selected chain.
  useEffect(() => {
    escrowBalance().then(setEscrowBal).catch(() => {});
    fetchDisputeIds().then((d) => setDisputes(d.length)).catch(() => {});
  }, [sel]);

  const load = useCallback(async (id: string) => {
    if (!id) { setChain(null); setAg(null); setDeposits([]); setVerdict(null); return; }
    try {
      const [c, a] = await Promise.all([fetchChain(id).catch(() => null), getAgreement(id).catch(() => null)]);
      setChain(c);
      setAg(a);
      setDeposits(a?.exists ? await getDeposits(id, a.depositCount).catch(() => []) : []);
      // Only ask the judge once the chain has fully run: before that there is no verdict.
      if (c && c.stepsDone >= c.stepsTotal && c.stepsTotal > 0) {
        setVerdict(await fetchVerdict(id).catch(() => null));
      } else setVerdict(null);
    } catch (e) { console.error('overview load', e); }
  }, []);

  useEffect(() => { setBridge(null); setSettleTx(null); load(sel); }, [sel, load]);

  // Surface node retries instead of leaving a button reading "Signing..." with nothing
  // happening: a busy node can delay the wallet prompt by tens of seconds.
  useEffect(() => {
    onRpcRetry((m) => setNote(m));
    return () => onRpcRetry(null);
  }, []);

  // Step transactions come from the NODE, not from this browser's tx store, which only holds
  // what was signed in this tab and is gone after a cache clear or on another machine.
  useEffect(() => {
    if (!sel) { setStepTxs([]); return; }
    let alive = true;
    fetchStepTxs(sel).then((h) => { if (alive) setStepTxs(h); });
    return () => { alive = false; };
  }, [sel, chain?.stepsDone]);

  // The refund authorisation lives on the agents contract; read it once the chain is cancelled.
  useEffect(() => {
    if (!sel || chain?.status !== 'cancelled') { setRefundTx(null); return; }
    let alive = true;
    fetchRefundTx(sel).then((h) => { if (alive) setRefundTx(h); });
    return () => { alive = false; };
  }, [sel, chain?.status]);

  // Verdict proofs come from the NODE, not from this browser's tx store, so the modal shows
  // them on any machine and after a cache clear. Loaded only when the modal opens.
  useEffect(() => {
    if (!verdictOpen || !sel) return;
    let alive = true;
    fetchVerdictProof(sel).then((p) => { if (alive) setProof(p); });
    return () => { alive = false; };
  }, [verdictOpen, sel]);

  // The settlement transaction is sent by the bridge receiver, not by this browser, so it
  // is read from Base logs once the escrow reports settled.
  useEffect(() => {
    if (!sel || !ag?.settled) { setSettleTx(null); return; }
    let alive = true;
    getSettlementTx(sel).then((h) => { if (alive) setSettleTx(h); });
    return () => { alive = false; };
  }, [sel, ag?.settled]);

  // Settlement poll, driven by ON-CHAIN state, not by whether this session pressed
  // Settle: runs whenever a decided verdict is not yet settled, including right after
  // a page refresh. Reads escrow + per-chain bridge each tick; stops once settled.
  useEffect(() => {
    const decidedNow = disputeStage(verdict) === 'decided';
    // A refund crosses the same bridge and also ends in escrow.settled, but it has no
    // verdict, so keying the poll on "decided" alone left cancelled chains never updating.
    const refundCrossing = chain?.status === 'cancelled' && !!ag?.exists;
    if (!sel || (!decidedNow && !refundCrossing) || ag?.settled) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } return; }
    let alive = true;
    const tick = async () => {
      try {
        const [a, b] = await Promise.all([getAgreement(sel), bridgeStatus(sel)]);
        if (!alive) return;
        setAg(a); setBridge(b);
        if (a.settled) escrowBalance().then(setEscrowBal).catch(() => {});
      } catch { /* keep polling */ }
    };
    tick(); pollRef.current = window.setInterval(tick, 20000);
    return () => { alive = false; if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [sel, verdict, ag?.settled, ag?.exists, chain?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Verdict poll: after judge_dispute, watch get_verdict until status == "judged"
  // (or NO_MAJORITY). Only then does the "View verdict" button light up.
  useEffect(() => {
    if (!judging || !sel) { if (judgePollRef.current) { clearInterval(judgePollRef.current); judgePollRef.current = null; } return; }
    const tick = async () => {
      try {
        const v = await fetchVerdict(sel);
        const st = disputeStage(v);
        if (st === 'decided') { setVerdict(v); setJudging(false); setNote(`Verdict ready: ${v.verdict}. Open "View verdict" for the reasoning.`); }
        else if (st === 'no_majority') { setVerdict(v); setJudging(false); setNote('No majority: the committee did not converge. Press Dispute again to re-send.'); }
      } catch { /* keep polling */ }
    };
    tick(); judgePollRef.current = window.setInterval(tick, 15000);
    return () => { if (judgePollRef.current) { clearInterval(judgePollRef.current); judgePollRef.current = null; } };
  }, [judging, sel]);

  const roleFor = (agentId: string) => prodAgents.find((a) => a.agentId === agentId)?.role || agentId;
  const ownerFor = (agentId: string) => prodAgents.find((a) => a.agentId === agentId)?.owner;
  const payoutFor = (agentId: string): bigint => {
    const owner = ownerFor(agentId);
    const d = owner ? deposits.find((x) => eq(x.beneficiary, owner)) : undefined;
    return d?.amount ?? 0n;
  };

  const stepsDone = chain?.stepsDone ?? 0;
  const stepsTotal = chain?.stepsTotal ?? 0;
  const running = !!chain && chain.status === 'open' && !ag?.settled;
  const complete = stepsTotal > 0 && stepsDone >= stepsTotal;
  const dstage = disputeStage(verdict);
  const settled = !!ag?.settled;
  const decided = dstage === 'decided';
  // Verdict settlement in flight: decided but escrow not settled (survives refresh).
  const verdictInFlight = decided && !settled;
  // Refund (cancel) in flight: chain cancelled on GenLayer, escrow not settled yet. The
  // refund bridge message has a different ABI shape than a verdict, so its progress is
  // shown from escrow state only (kept functional, not polished).
  const refundInFlight = chain?.status === 'cancelled' && !!ag?.exists && !settled;
  // Where the workflow is blocked on the USER rather than on the network. Derived from the
  // exact conditions that enable each button, and reused by both, so a stage can never say
  // "your turn" while its button is disabled (or the reverse).
  const canRun = !busy && running && !complete;
  const canDispute = !busy && complete && !settled && dstage !== 'decided';
  const canSettle = !busy && !settled && decided && !bridge?.dispatched;

  // Cross-chain tracker phase, from persistent reads (bridge + escrow). escrow.settled is
  // terminal; 'awaiting_bridge' covers the honest emit-latency window after dispatch.
  const settlePhase: 'none' | 'awaiting_bridge' | 'dispatched' | 'crossing' | 'paid' =
    settled && decided ? 'paid'
    : !verdictInFlight ? 'none'
    : bridge?.forwarded ? 'crossing'
    : bridge?.dispatched ? 'dispatched'
    : 'awaiting_bridge';

  // ---- guided actions (one signature each, all GenLayer writes) ----
  async function withWallet(kind: string, fn: (acc: `0x${string}`) => Promise<void>) {
    if (!w.isConnected) return w.connect();
    setNote('Preparing the transaction...');
    try {
      setBusy(kind);
      if (!w.onGenLayer) await w.switchToGenLayer();
      await fn(w.address as `0x${string}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const network = /failed to fetch|fetch failed|network ?error|networkerror|load failed|connection|econnreset|socket hang up/i.test(msg);
      // A network failure can also mean "the call landed and the answer was lost", so the
      // request itself is not evidence of anything. Re-read the contract, which is the only
      // honest source, and tell the user what the refreshed view already shows.
      await load(sel).catch(() => {});
      setNote(network
        ? 'The node did not answer. The view was refreshed from chain: if the step did not land, press again.'
        : 'Failed: ' + msg.slice(0, 160));
    } finally { setBusy(''); }
  }

  const onRun = () => withWallet('run', async (acc) => {
    const nextAgent = chain?.plan?.[stepsDone] || '';
    const h = await runNextStep(acc, sel);
    recordTx({ chainId: sel, kind: 'run', label: nextAgent ? `Run ${roleFor(nextAgent)}` : 'Run next step', network: 'genlayer', hash: h, ref: nextAgent });
    setNote('Step submitted on GenLayer.');
    await load(sel);
  });

  const onDispute = () => withWallet('dispute', async (acc) => {
    const e = await exportForJudge(sel);
    const sh = await submitChainDispute(acc, sel, e);
    recordTx({ chainId: sel, kind: 'submit_dispute', label: 'Submit dispute', network: 'genlayer', hash: sh });
    const jh = await judgeDispute(acc, sel);
    recordTx({ chainId: sel, kind: 'judge_dispute', label: 'Judge dispute', network: 'genlayer', hash: jh });
    // A ruling rewrites every participant's reputation, so it must not wait for a reload.
    refreshAgentsAndReputation();
    const v = await fetchVerdict(sel).catch(() => null);
    setVerdict(v);
    const st = disputeStage(v);
    if (st === 'decided') { setJudging(false); setNote(`Verdict ready: ${v?.verdict}. Open "View verdict" for the reasoning.`); }
    else if (st === 'no_majority') { setJudging(false); setNote('No majority yet: the committee did not converge. Press Dispute again to re-send to a fresh committee.'); }
    else { setJudging(true); setNote('Dispute submitted. The judge is deliberating, the verdict will appear shortly.'); }
  });

  // Settle (dispatch_verdict) is a ONE-SHOT cross-chain action. The re-dispatch guard
  // is derived on-chain: the button disables once bridge.dispatched turns true (the
  // message is queued in the BridgeSender). During the async emit-latency window it may
  // stay enabled briefly; a second dispatch is harmless (idempotent emit + escrow replay
  // protection). The definitive "done" is escrow.getAgreement().settled, watched by the
  // settlement poll above, which runs on mount whenever a decided verdict is unsettled.
  const onSettle = async () => {
    if (!w.isConnected) return w.connect();
    if (busy || settled || dstage !== 'decided' || bridge?.dispatched) return; // don't re-dispatch a queued verdict
    setNote(''); setBusy('settle');
    try {
      if (!w.onGenLayer) await w.switchToGenLayer();
      const h = await dispatchVerdict(w.address as `0x${string}`, sel);
      recordTx({ chainId: sel, kind: 'dispatch_verdict', label: 'Dispatch verdict', network: 'genlayer', hash: h });
      setNote('Verdict dispatched. Settlement is tracked below, it can take a few minutes.');
      await load(sel);
      bridgeStatus(sel).then(setBridge).catch(() => {}); // seed the tracker; the poll takes over
    } catch (e: any) {
      setNote('Failed to dispatch: ' + String(e?.message || e).slice(0, 160));
    } finally { setBusy(''); }
  };

  const onCancel = async () => {
    if (!w.isConnected) return w.connect();
    if (busy || settled || stepsDone > 0) return; // guard: one signature only
    setNote(''); setBusy('cancel');
    try {
      if (!w.onGenLayer) await w.switchToGenLayer();
      const h = await cancelChain(w.address as `0x${string}`, sel);
      recordTx({ chainId: sel, kind: 'cancel_chain', label: 'Cancel chain', network: 'genlayer', hash: h });
      setNote('Cancel submitted. Deposits refund on Base within a few minutes.');
      await load(sel);
      await reloadChainIds();
    } catch (e: any) {
      setNote('Failed to cancel: ' + String(e?.message || e).slice(0, 160));
    } finally { setBusy(''); }
  };

  // ---- pipeline model (4 agents + judge + settle) ----
  const pipe = useMemo(() => {
    const plan = chain?.plan ?? [];
    const cancelled = chain?.status === 'cancelled';
    const refundCrossingNow = cancelled && !!ag?.exists && !ag?.settled;
    const blocks = plan.map((agentId, i) => {
      let state: PipeState;
      // A cancelled chain will never run its remaining steps: leaving them QUEUED tells the
      // user something is still coming when nothing is.
      if (cancelled && i >= stepsDone) state = 'cancelled';
      else if (i < stepsDone) state = 'done';
      else if (i === stepsDone && canRun) state = 'waiting';
      else if (i === stepsDone && running) state = 'active';
      else state = 'pending';
      return { kind: 'agent' as const, agentId, name: (roleFor(agentId) || agentId).toUpperCase(), idx: i + 1, state, sub: '' };
    });
    const judgeState: PipeState =
      dstage === 'decided' ? 'done' : cancelled ? 'cancelled' : canDispute ? 'waiting' : complete && !ag?.settled ? 'active' : 'pending';
    const settleState: PipeState =
      ag?.settled ? 'done' : canSettle ? 'waiting' : dstage === 'decided' || refundCrossingNow ? 'active' : cancelled ? 'cancelled' : 'pending';
    blocks.push({ kind: 'agent', agentId: '', name: 'JUDGE', idx: blocks.length + 1, state: judgeState, sub: 'GENLAYER' } as any);
    blocks.push({ kind: 'agent', agentId: '', name: 'SETTLE', idx: blocks.length + 1, state: settleState, sub: 'BASE' } as any);
    return blocks;
  }, [chain, stepsDone, running, complete, dstage, ag, canRun, canDispute, canSettle]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the client got back: the sum of every at-fault agent's share. Derived from the
  // same rule the escrow applies, so the ledger cannot drift from the on-chain split.
  const recoveredByClient = useMemo(
    () => deposits.reduce(
      (sum, d) => ((ag?.culpableAgents ?? []).some((c) => eq(c, d.beneficiary)) ? sum + d.amount : sum),
      0n,
    ),
    [deposits, ag],
  );

  const refunded = settled && ag?.verdict === 'REFUNDED';
  const stateLabel = (s: string, isSettle = false) =>
    s === 'done' ? (isSettle && refunded ? 'REFUNDED' : 'COMPLETE')
    : s === 'active' ? 'RUNNING'
    : s === 'waiting' ? 'YOUR TURN'
    : s === 'cancelled' ? 'CANCELLED'
    : 'QUEUED';

  // ---- feed (derived from real chain steps + escrow) ----
  const feed = useMemo(() => {
    const lines: { src: string; verb: string; text: string }[] = [];
    if (chain) lines.push({ src: 'SYN_COORDINATOR', verb: 'DISPATCH', text: `Parsing request: "${chain.agreement}"` });
    (chain?.steps ?? []).forEach((s) => lines.push({ src: (s.agentId || '').toUpperCase(), verb: 'SUBMIT', text: (s.delivered || '').slice(0, 160) }));
    if (ag?.exists && ag.total > 0n) lines.push({ src: 'ESCROW_BASE', verb: 'LOCK_PAY', text: `${formatUsdc(ag.total)} USDC locked across ${ag.depositCount} agent beneficiaries.` });
    if (ag?.settled) lines.push({ src: 'ESCROW_BASE', verb: 'SETTLE', text: `Settled by verdict ${ag.verdict || ''}.` });
    return lines;
  }, [chain, ag]);

  const statusTag = ag?.settled
    ? { cls: 'syn-tag syn-tag--done', label: ag.verdict === 'REFUNDED' ? 'REFUNDED' : 'SETTLED' }
    : chain?.status === 'cancelled' ? { cls: 'syn-tag syn-tag--waiting', label: 'CANCELLED' }
    : running ? { cls: 'syn-tag syn-tag--running', label: 'RUNNING' }
    : { cls: 'syn-tag syn-tag--waiting', label: 'OPEN' };

  const noFault = (verdict?.culpableAgents?.length ?? 0) === 0;

  // Single source of truth for culprits: the judge's verdict read (get_verdict), NOT the
  // escrow event/getAgreement (settlement copy, later + cross-chain lagged). Modal and
  // cards both read this, so they never disagree.
  const culprits = useMemo(
    () => new Set((verdict?.culpableAgents ?? []).map((a) => a.toLowerCase())),
    [verdict],
  );
  // A card is a culprit iff its agent's beneficiary (== its owner, the address the judge
  // blames) is in the culprits array AND a verdict has actually been decided.
  const isCulprit = (agentId: string) => {
    const o = ownerFor(agentId);
    return dstage === 'decided' && !!o && culprits.has(o.toLowerCase());
  };

  return (
    <>
    <section id="screen-overview">
      <h1>System Executive Control</h1>
      <p className="syn-sub">Chained AI agents, judged on-chain, paid out of escrow across two networks.</p>

      <div className="syn-stats" id="overview-stats">
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">REGISTERED AGENTS</span><span className="syn-stat__net">GENLAYER</span></div><div className="syn-stat__value">{prodAgents.length}</div></div>
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">WORKFLOWS</span><span className="syn-stat__net">GENLAYER</span></div><div className="syn-stat__value">{chainIds.length}</div></div>
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">USDC IN ESCROW</span><span className="syn-stat__net syn-stat__net--base">BASE</span></div><div className="syn-stat__value">${formatUsdc(escrowBal)}</div></div>
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">DISPUTES JUDGED</span><span className="syn-stat__net">GENLAYER</span></div><div className="syn-stat__value">{disputes}</div></div>
      </div>

      {!chain && (
        <div className="syn-panel" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p className="syn-sub" style={{ margin: 0, flex: 1 }}>No active chain. Create a workflow from the sidebar to begin.</p>
          {chainIds.length > 1 && (
            <select aria-label="Active chain" className="syn-input" value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: 'auto', maxWidth: 220, padding: '6px 9px', fontSize: 11.5 }}>
              {chainIds.slice().reverse().map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          )}
        </div>
      )}

      {chain && (
        <section className="syn-panel" id="active-chain" data-chain-id={sel} style={{ marginBottom: 16, marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="syn-kicker">CHAIN {sel}</span>
                <span className={statusTag.cls}>{statusTag.label}</span>
                {verdict?.verdict && <span className="syn-tag syn-tag--done">VERDICT {verdict.verdict}</span>}
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15.5, color: 'var(--color-neutral-100)' }}>{chain.agreement}</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--color-neutral-600)', marginTop: 4 }}>
                client {truncateAddress(chain.client)} - {stepsDone}/{stepsTotal} steps - {formatUsdc(ag?.total ?? 0n)} USDC deposited
              </div>
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }} id="chain-actions">
              {chainIds.length > 1 && (
                <select aria-label="Active chain" className="syn-input" value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: 'auto', maxWidth: 190, padding: '6px 9px', fontSize: 11.5 }}>
                  {chainIds.slice().reverse().map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              )}
              <button type="button" className="syn-btn" disabled={!!busy || !running || complete} onClick={onRun}>{busy === 'run' ? 'Signing…' : 'Run next step'}</button>
              <button type="button" className="syn-btn syn-btn--secondary" disabled={!!busy || !complete || settled || dstage === 'decided'} onClick={onDispute}>{busy === 'dispute' ? 'Signing…' : dstage === 'no_majority' ? 'Re-send dispute' : 'Dispute'}</button>
              <button type="button" className="syn-btn syn-btn--secondary" disabled={!!busy || settled || dstage !== 'decided' || !!bridge?.dispatched} onClick={onSettle}>{busy === 'settle' ? 'Signing…' : (bridge?.dispatched && !settled) ? 'Settling on Base…' : 'Settle verdict'}</button>
              <button type="button" className="syn-btn syn-btn--ghost" disabled={!!busy || settled || stepsDone > 0 || refundInFlight} onClick={onCancel}>{busy === 'cancel' ? 'Signing…' : 'Cancel'}</button>
              {dstage === 'decided' && <button type="button" className="syn-btn" onClick={() => setVerdictOpen(true)}>View verdict</button>}
            </div>
          </div>

          {(judging || refundInFlight) && (
            <div className="syn-runstate" data-tone={judging ? 'amber' : 'cyan'}>
              <span className="syn-pipe__dot" />
              {judging ? 'Judge deliberating on GenLayer...' : 'Refund crossing to Base, settlement tracked below.'}
            </div>
          )}

          <div className="syn-pipe" id="chain-pipeline">
          {pipe.map((b, i) => (
            <div className="syn-pipe__block" key={i} data-state={b.state}>
              <div className="syn-pipe__idx">STAGE {String(b.idx).padStart(2, '0')}</div>
              <div className="syn-pipe__name">{b.name}{b.sub && <span className="syn-pipe__badge" data-net={b.sub === 'BASE' ? 'base' : 'genlayer'}>{b.sub}</span>}</div>
              <div className="syn-pipe__state"><span className="syn-pipe__dot" />{stateLabel(b.state, b.name === 'SETTLE')}</div>
              <div className="syn-pipe__bar"><i /></div>
            </div>
          ))}
          </div>

          <aside className="syn-settle-card" aria-live="polite">
            <div className="syn-kicker">CROSS-CHAIN SETTLEMENT</div>
            {settlePhase === 'none' && !refundInFlight && !refunded ? (
              <p className="syn-settle-idle">
                {refunded ? 'Refunded on Base. Every deposit went back to whoever put it in.'
                  : settled ? 'Settled.'
                  : 'Runs once the verdict is dispatched to Base.'}
              </p>
            ) : refunded ? (
              <>
                <p className="syn-settle-idle">Refunded on Base. Every deposit went back to whoever put it in.</p>
                {settleTx && <TxLink hash={settleTx} prefix="tx" network="base" />}
              </>
            ) : refundInFlight ? (
              <>
                <div className="syn-settle-steps">
                  <SettleStep done={!!refundTx} active={!refundTx} label="Refund authorised" />
                  <SettleStep done={false} active={!!refundTx} label="Crossing to Base..." />
                  <SettleStep done={false} label="Back to depositors" />
                </div>
                {refundTx && <TxLink hash={refundTx} prefix="tx" />}
                <div className="syn-settle-note">Cross-chain, this can take several minutes.</div>
              </>
            ) : (
              <>
                <div className="syn-settle-steps">
                  <SettleStep done={settlePhase === 'dispatched' || settlePhase === 'crossing' || settlePhase === 'paid'} active={settlePhase === 'awaiting_bridge'} label="Verdict dispatched" />
                  <SettleStep done={settlePhase === 'paid'} active={settlePhase === 'crossing'} label={settlePhase === 'paid' ? 'Crossed the bridge' : 'Crossing the bridge…'} />
                  <SettleStep done={settlePhase === 'paid'} label="Paid on Base" />
                </div>
                {verdict?.verdict && (
                  <div className="syn-settle-verdict">
                    <span className={noFault ? 'syn-tag syn-tag--done' : 'syn-tag syn-tag--fault'}>{verdict.verdict}</span>
                  </div>
                )}
                <div className="syn-settle-note">{settlePhase === 'paid' ? 'Settled on Base.' : 'Cross-chain, this can take several minutes.'}</div>
              </>
            )}
          </aside>

          <div className="syn-chain" id="chain-steps">
            {(chain.plan ?? []).map((agentId, i) => {
              const step = chain.steps?.[i];
              const state = i < stepsDone ? 'complete' : i === stepsDone && running ? 'processing' : 'waiting';
              const stepTag = state === 'complete' ? { cls: 'syn-tag syn-tag--done', label: 'COMPLETE' } : state === 'processing' ? { cls: 'syn-tag syn-tag--running', label: 'PROCESSING' } : { cls: 'syn-tag syn-tag--waiting', label: 'WAITING' };
              const deliverable = step?.delivered || (state === 'processing' ? 'Working on the handoff from the previous link…' : 'Queued.');
              const payout = payoutFor(agentId);
              const culprit = isCulprit(agentId);
              return (
                <div className="syn-chain__slot" key={agentId + i}>
                  <div className="syn-chain__arrow"><ArrowIcon /><span>output to input</span></div>
                  <article className="syn-agent" data-step={i + 1} data-agent-id={agentId} data-state={state} data-culprit={culprit || undefined}
                    style={culprit ? { borderColor: 'var(--syn-red)', boxShadow: 'inset 0 0 0 1px var(--syn-red)' } : undefined}>
                    <div className="syn-agent__head"><span className="syn-lights syn-lights--color"><i /><i /><i /></span><span className="syn-agent__id">{agentId.toUpperCase()}</span>{culprit ? <span className="syn-tag syn-tag--fault">FAILED, refunded to client</span> : <span className={stepTag.cls}>{stepTag.label}</span>}</div>
                    <div className="syn-agent__body">
                      <div className="syn-agent__meta" style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(i + 1).padStart(2, '0')} - {roleFor(agentId)}</span>{stepTxs[i] ? <TxLink hash={stepTxs[i]} prefix="tx" /> : <TxHashLink chainId={sel} kind="run" refId={agentId} prefix="tx" />}</div>
                      <div className="syn-agent__io"><b>IN</b> {i === 0 ? 'agreement' : 'prev output'} <span>-&gt;</span> <b>OUT</b> deliverable</div>
                      <div className="syn-agent__out">{deliverable}</div>
                      <button type="button" className="syn-agent__more" onClick={() => setOutputModal({ agentId, index: i, state, deliverable, payout })}>READ MORE ↓</button>
                      <div className="syn-agent__foot"><span>{truncateAddress(ownerFor(agentId))}</span><span className="syn-agent__pay">{formatUsdc(payout)} USDC</span></div>
                    </div>
                  </article>
                </div>
              );
            })}

            {/* Production agents NOT selected for this chain (plan < 4): shown dimmed
                and tagged so it is clear who participates in this workflow and who does not. */}
            {prodAgents.filter((a) => !(chain.plan ?? []).includes(a.agentId)).map((a) => (
              <div className="syn-chain__slot" key={'not-' + a.agentId}>
                <div className="syn-chain__arrow" style={{ visibility: 'hidden' }}><ArrowIcon /><span>output to input</span></div>
                <article className="syn-agent is-short" data-agent-id={a.agentId} data-state="excluded" style={{ opacity: 0.5 }}>
                  <div className="syn-agent__head"><span className="syn-lights"><i /><i /><i /></span><span className="syn-agent__id">{a.agentId.toUpperCase()}</span><span className="syn-tag syn-tag--waiting">NOT IN THIS CHAIN</span></div>
                  <div className="syn-agent__body">
                    <div className="syn-agent__meta">- {a.role || a.agentId}</div>
                    <div className="syn-agent__out" style={{ color: 'var(--color-neutral-600)' }}>Not part of this workflow.</div>
                    <div className="syn-agent__foot"><span>{truncateAddress(a.owner)}</span><span className="syn-agent__pay">no deposit</span></div>
                  </div>
                </article>
              </div>
            ))}
          </div>

          {note && <p className="syn-sub" style={{ marginTop: 12, marginBottom: 0 }}>{note}</p>}
        </section>
      )}

      {chain && (
        <div className="syn-grid-2">
          <section className="syn-term" id="activity-feed">
            <div className="syn-term__bar"><span className="syn-lights"><i /><i /><i /></span><span className="syn-term__title">LIVE ACTIVITY FEED [TTY::01]</span></div>
            <div className="syn-feed" id="activity-feed-lines">
              {feed.length === 0 && <div className="syn-feed__line"><span className="syn-feed__text">No activity yet.</span></div>}
              {feed.map((l, i) => (
                <div className="syn-feed__line" key={i}><span className="syn-feed__src">{l.src}</span><span className="syn-feed__verb">{l.verb}</span><span className="syn-feed__text">{l.text}</span></div>
              ))}
            </div>
          </section>

          <section className="syn-card" id="escrow-ledger" style={{ overflow: 'hidden' }}>
            <div className="syn-sect__head"><span className="syn-sect__title">ESCROW LEDGER</span><span className="syn-sect__net">BASE SEPOLIA</span></div>
            <div className="syn-rows" id="escrow-ledger-rows">
              {deposits.length === 0 && <div className="syn-row"><span className="syn-row__kind">No deposits yet.</span></div>}
              {deposits.map((d, i) => {
                const aid = prodAgents.find((a) => eq(a.owner, d.beneficiary))?.agentId;
                // Shared rule: the ledger cannot disagree with the escrow view or the slots.
                const out = depositOutcome(ag, d.beneficiary, refundInFlight);
                const atFault = out.kind === 'withheld';
                const label = out.label;
                const tone = out.kind === 'paid' ? 'syn-tag--done'
                  : out.kind === 'withheld' ? 'syn-tag--fault'
                  : out.kind === 'refunded' ? 'syn-tag--waiting'
                  : out.kind === 'refunding' ? 'syn-tag--processing'
                  : 'syn-tag--running';
                return (
                  <div className="syn-row" key={i}>
                    <span className="syn-row__tx">#{i + 1}</span>
                    <span className="syn-row__kind">{aid || 'DEPOSIT'}{atFault && ag?.settled ? ' (at fault)' : ''}</span>
                    <span className="syn-row__amount">${formatUsdc(d.amount)}</span>
                    {aid && <TxHashLink chainId={sel} kind="deposit" refId={aid} />}
                    <span className={`syn-tag ${tone}`}>{label}</span>
                  </div>
                );
              })}
              {ag?.settled && ag.verdict !== 'REFUNDED' && recoveredByClient > 0n && (
                <div className="syn-row">
                  <span className="syn-row__tx">=</span>
                  <span className="syn-row__kind">client {truncateAddress(ag.client)}</span>
                  <span className="syn-row__amount">${formatUsdc(recoveredByClient)}</span>
                  <span className="syn-tag syn-tag--done">RECOVERED</span>
                </div>
              )}
              {ag?.settled && (
                <div className="syn-row">
                  <span className="syn-row__tx">tx</span>
                  <span className="syn-row__kind">payout transaction</span>
                  {settleTx ? (
                    <a className="syn-txlink" href={txUrl('base', settleTx) || '#'} target="_blank" rel="noopener noreferrer" title={settleTx}>
                      {truncateAddress(settleTx)} ↗
                    </a>
                  ) : (
                    <span className="mono" style={{ fontSize: 10, color: 'var(--color-neutral-600)' }}>outside the log window</span>
                  )}
                  <span className="syn-tag syn-tag--done">ONE TX</span>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </section>

    {verdictOpen && verdict && (
      <div className="syn-modal" role="dialog" aria-modal="true" aria-labelledby="verdict-title" onClick={(e) => { if (e.target === e.currentTarget) setVerdictOpen(false); }}>
        <div className="syn-modal__window" style={{ width: 'min(480px, 100%)' }}>
          <div className="syn-modal__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 id="verdict-title">Judge verdict</h1>
              <p className="syn-sub" style={{ margin: 0 }}>Chain {sel} - read from judge.get_verdict</p>
            </div>
            <button type="button" className="syn-modal__close" aria-label="Close" onClick={() => setVerdictOpen(false)}><CloseIcon /></button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div className="syn-kicker" style={{ marginBottom: 6 }}>VERDICT</div>
              <span className={noFault ? 'syn-tag syn-tag--done' : 'syn-tag syn-tag--fault'} style={{ fontSize: 12, padding: '4px 9px' }}>{verdict.verdict || '-'}</span>
            </div>
            <div>
              <div className="syn-kicker" style={{ marginBottom: 6 }}>CULPABLE AGENTS</div>
              {noFault ? (
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--color-neutral-300)', wordBreak: 'break-all' }}>None. No agent at fault.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {verdict.culpableAgents.map((addr) => {
                    const aid = prodAgents.find((a) => eq(a.owner, addr))?.agentId;
                    return (
                      <div key={addr} className="mono" style={{ fontSize: 11.5, color: 'var(--syn-red)', wordBreak: 'break-all' }}>
                        {aid ? `${aid.toUpperCase()}  ` : ''}{addr}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <div className="syn-kicker" style={{ marginBottom: 6 }}>REASON</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--color-neutral-400)', maxHeight: 260, overflow: 'auto' }}>{verdict.reason || 'No reason returned by the judge.'}</div>
            </div>
            <div>
              <div className="syn-kicker" style={{ marginBottom: 6 }}>TRANSACTION PROOF</div>
              <div style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                <ProofRow label="Judged" net="GENLAYER" hash={proof.judged} network="genlayer" />
                <ProofRow label="Verdict dispatched" net="GENLAYER" hash={proof.dispatched} network="genlayer" />
                <ProofRow label="Paid out" net="BASE" hash={settleTx} network="base" last />
              </div>
            </div>
          </div>
        </div>
      </div>
    )}

    {outputModal && (() => {
      const tag = outputModal.state === 'complete' ? { cls: 'syn-tag syn-tag--done', label: 'COMPLETE' }
        : outputModal.state === 'processing' ? { cls: 'syn-tag syn-tag--running', label: 'PROCESSING' }
        : { cls: 'syn-tag syn-tag--waiting', label: 'WAITING' };
      return (
        <div className="syn-modal" role="dialog" aria-modal="true" aria-labelledby="output-title" onClick={(e) => { if (e.target === e.currentTarget) setOutputModal(null); }}>
          <div className="syn-modal__window" style={{ width: 'min(640px, 100%)' }}>
            <div className="syn-modal__head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 id="output-title">{outputModal.agentId.toUpperCase()} Output</h1>
                <p className="syn-sub" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>STAGE {String(outputModal.index + 1).padStart(2, '0')}<span className={tag.cls}>{tag.label}</span></p>
              </div>
              <button type="button" className="syn-modal__close" aria-label="Close" onClick={() => setOutputModal(null)}><CloseIcon /></button>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--color-neutral-300)', maxHeight: '70vh', overflow: 'auto', background: '#101312', border: '1px solid var(--color-neutral-900)', borderRadius: 'var(--radius-md)', padding: '12px 13px' }}>
              {renderMarkdown(outputModal.deliverable)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-divider)' }}>
              {stepTxs[outputModal.index] ? <TxLink hash={stepTxs[outputModal.index]} prefix="GenLayer tx" /> : <TxHashLink chainId={sel} kind="run" refId={outputModal.agentId} prefix="GenLayer tx" fallback="Not found on chain yet." />}
              <span className="mono" style={{ fontSize: 12, color: 'var(--color-neutral-300)' }}>{formatUsdc(outputModal.payout)} USDC</span>
            </div>
          </div>
        </div>
      );
    })()}
    </>
  );
}
