import { useEffect, useState, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { useWallet } from '../hooks/useWallet';
import { getAgreementIds, getAgreement, getDeposits, fundedAt, refundTimeout, getSettlementTx, depositOutcome, Agreement, DepositRow } from '../lib/base';
import { cancelChain, claimTimeout, dispatchVerdict, fetchChain, fetchRefundTx, onRpcRetry } from '../lib/genlayer';
import { ESCROW_ADDRESS, truncateAddress, formatUsdc, txUrl } from '../constants';
import { TxHashLink } from './TxHashLink';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function EscrowView() {
  const w = useWallet();
  const { prodAgents, recordTx } = useApp();
  const [ids, setIds] = useState<string[]>([]);
  const [settleTx, setSettleTx] = useState<`0x${string}` | null>(null);
  // This view reads Base. A refund is authorised on GenLayer FIRST and only reaches Base
  // minutes later, so without the GenLayer side the escrow would sit at OPEN/LOCKED with no
  // hint that money is already on its way back.
  const [refund, setRefund] = useState<{ inFlight: boolean; tx: string | null }>({ inFlight: false, tx: null });
  const [sel, setSel] = useState<string>('');
  const [ag, setAg] = useState<Agreement | null>(null);
  const [deposits, setDeposits] = useState<DepositRow[]>([]);
  const [timeoutInfo, setTimeoutInfo] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [settling, setSettling] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => { getAgreementIds().then((x) => { setIds(x); if (x.length && !sel) setSel(x[x.length - 1]); }).catch(console.error); }, []);

  // While a settle is in flight cross-chain, poll the definitive signal; the button
  // stays disabled so the verdict is never dispatched twice (that caused the 4 signs).
  useEffect(() => {
    // Driven by on-chain state, not by whether this tab pressed the button: a refund
    // authorised from the Overview (or before a reload) must still land here on its own.
    const crossing = settling || refund.inFlight;
    if (!crossing || !sel || ag?.settled) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } return; }
    const tick = async () => { try { const a = await getAgreement(sel); if (a.settled) { setSettling(false); load(sel); } } catch { /* keep polling */ } };
    tick(); pollRef.current = window.setInterval(tick, 20000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [settling, sel, refund.inFlight, ag?.settled]);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const a = await getAgreement(id);
      setAg(a);
      setDeposits(a.exists ? await getDeposits(id, a.depositCount) : []);
      const [f, t] = await Promise.all([fundedAt(id).catch(() => 0n), refundTimeout().catch(() => 3600n)]);
      if (f > 0n) {
        const eligible = Number(f) + Number(t);
        const now = Math.floor(Date.now() / 1000);
        const mins = Math.max(0, Math.round((eligible - now) / 60));
        setTimeoutInfo(`refundTimeout ${Number(t) / 3600}h - ${now >= eligible ? 'timeout-refund eligible now' : `eligible in ~${mins} min`}`);
      } else setTimeoutInfo(`refundTimeout ${Number(t) / 3600}h`);
    } catch (e) { console.error('escrow load', e); }
  }, []);

  useEffect(() => { load(sel); }, [sel, load]);

  async function runGenLayer(kind: 'settle' | 'cancel' | 'timeout') {
    if (!w.isConnected) return w.connect();
    setNote('');
    try {
      setBusy(kind);
      if (!w.onGenLayer) await w.switchToGenLayer();
      const acc = w.address as `0x${string}`;
      if (kind === 'settle') { const h = await dispatchVerdict(acc, sel); recordTx({ chainId: sel, kind: 'dispatch_verdict', label: 'Dispatch verdict', network: 'genlayer', hash: h }); setSettling(true); }
      if (kind === 'cancel') { const h = await cancelChain(acc, sel); recordTx({ chainId: sel, kind: 'cancel_chain', label: 'Cancel chain', network: 'genlayer', hash: h }); setSettling(true); }
      if (kind === 'timeout') { const h = await claimTimeout(acc, sel); recordTx({ chainId: sel, kind: 'claim_timeout', label: 'Claim timeout refund', network: 'genlayer', hash: h }); setSettling(true); }
      setNote('Submitted. It crosses the bridge to Base; the relay settles it within a few minutes (do not sign again).');
      await load(sel);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const network = /failed to fetch|fetch failed|network ?error|networkerror|load failed|connection|econnreset|socket hang up/i.test(msg);
      // Same rule as Overview: a network failure is not evidence that the call did not
      // land, so the contract is re-read and the user is told what the refreshed view shows.
      await load(sel).catch(() => {});
      setNote(network
        ? 'The node did not answer. The view was refreshed from chain: if the action did not land, press again.'
        : 'Failed: ' + msg.slice(0, 140));
    } finally { setBusy(''); }
  }

  // Map a deposit beneficiary (owner address) back to its -mo agent id/role.
  const agentFor = (owner: string) => prodAgents.find((a) => eq(a.owner, owner));

  const status = ag?.settled ? (ag.verdict === 'REFUNDED' ? 'REFUNDED' : 'SETTLED') : refund.inFlight ? 'REFUND IN FLIGHT' : 'OPEN';

  // Surface node retries here too: a busy node can delay the wallet prompt by tens of
  // seconds, and silence looks like a frozen button.
  useEffect(() => {
    onRpcRetry((m) => setNote(m));
    return () => onRpcRetry(null);
  }, []);

  useEffect(() => {
    if (!sel || ag?.settled) { setRefund({ inFlight: false, tx: null }); return; }
    let alive = true;
    fetchChain(sel)
      .then(async (c) => {
        if (!alive || c.status !== 'cancelled') return;
        const tx = await fetchRefundTx(sel);
        if (alive) setRefund({ inFlight: true, tx });
      })
      .catch(() => { /* the escrow view still works from Base state alone */ });
    return () => { alive = false; };
  }, [sel, ag?.settled]);

  // The payout transaction is sent by the bridge receiver, so it is read from Base logs
  // rather than from this browser's tx store, which only holds what the user signed here.
  useEffect(() => {
    if (!sel || !ag?.settled) { setSettleTx(null); return; }
    let alive = true;
    getSettlementTx(sel).then((h) => { if (alive) setSettleTx(h); });
    return () => { alive = false; };
  }, [sel, ag?.settled]);

  // Per-payout status → design data-status + tag + note.
  function payout(d: DepositRow) {
    const out = depositOutcome(ag, d.beneficiary, refund.inFlight);
    const design = {
      locked:    { ds: 'locked',   tag: 'syn-tag syn-tag--running' },
      refunding: { ds: 'locked',   tag: 'syn-tag syn-tag--processing' },
      refunded:  { ds: 'refunded', tag: 'syn-tag syn-tag--waiting' },
      withheld:  { ds: 'refunded', tag: 'syn-tag syn-tag--waiting' },
      paid:      { ds: 'released', tag: 'syn-tag syn-tag--done' },
    }[out.kind];
    return { ...design, label: out.label, note: out.note };
  }

  return (
    <section id="screen-escrow">
      <h1>Escrow</h1>
      <p className="syn-sub">SynarchEscrow v2 - Base Sepolia - {truncateAddress(ESCROW_ADDRESS)}</p>

      {ids.length > 0 && (
        <div className="syn-field" style={{ maxWidth: 360 }}>
          <label htmlFor="escrow-select">Agreement</label>
          <select id="escrow-select" className="syn-input" value={sel} onChange={(e) => setSel(e.target.value)}>
            {ids.slice().reverse().map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      )}

      {ag && ag.exists && (
        <div className="syn-panel" id="escrow-agreement" data-chain-id={sel} style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
            <span className="syn-kicker">AGREEMENT {sel}</span>
            <span className={status === 'SETTLED' ? 'syn-tag syn-tag--done' : status === 'REFUNDED' ? 'syn-tag syn-tag--waiting' : 'syn-tag syn-tag--running'}>{status}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 19 }}>${formatUsdc(ag.total)}</span>
          </div>
          <div className="syn-payouts" id="escrow-payouts">
            {deposits.map((d, i) => {
              const a = agentFor(d.beneficiary);
              const p = payout(d);
              return (
                <div className="syn-payout" key={i} data-agent-id={a?.agentId} data-status={p.ds}>
                  <div className="syn-payout__head"><span className="syn-payout__slot">SLOT {String(i + 1).padStart(2, '0')}</span><span className={p.tag}>{p.label}</span></div>
                  <div className="syn-payout__id">{a?.agentId || truncateAddress(d.beneficiary)}</div>
                  <div className="syn-payout__owner">{truncateAddress(d.beneficiary)}</div>
                  <div className="syn-payout__amount">${formatUsdc(d.amount)}</div>
                  <div className="syn-payout__note">{p.note}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 14, flexWrap: 'wrap' }} id="escrow-actions">
            <button type="button" className="syn-btn syn-btn--secondary" disabled={!!busy || ag.settled || settling} onClick={() => runGenLayer('settle')}>{busy === 'settle' ? 'Signing…' : settling ? 'Settling…' : 'Settle by verdict'}</button>
            <button type="button" className="syn-btn syn-btn--ghost" disabled={!!busy || ag.settled || settling} onClick={() => runGenLayer('cancel')}>{busy === 'cancel' ? 'Signing…' : 'Cancel & refund'}</button>
            <button type="button" className="syn-btn syn-btn--ghost" disabled={!!busy || ag.settled || settling} onClick={() => runGenLayer('timeout')}>{busy === 'timeout' ? 'Signing…' : 'Claim timeout refund'}</button>
            <span className="mono" style={{ alignSelf: 'center', fontSize: 10, color: 'var(--color-neutral-600)' }}>{settling ? 'Settling on Base…' : timeoutInfo}</span>
          </div>
          {refund.inFlight && (
            <div className="syn-runstate" data-tone="cyan" style={{ marginTop: 12, marginBottom: 0 }}>
              <span className="syn-pipe__dot" />
              <span>Refund authorised on GenLayer, crossing to Base. Funds return to each depositor.</span>
              {refund.tx && (
                <a className="syn-txlink" style={{ marginLeft: 'auto' }} href={txUrl('genlayer', refund.tx) || '#'} target="_blank" rel="noopener noreferrer" title={refund.tx}>
                  {truncateAddress(refund.tx)} ↗
                </a>
              )}
            </div>
          )}
          {note && <p className="syn-sub" style={{ marginTop: 10 }}>{note}</p>}
        </div>
      )}

      {ag && ag.exists && (
        <div className="syn-card" style={{ marginTop: 14, overflow: 'hidden' }} id="deposit-log">
          <div className="syn-sect__head"><span className="syn-sect__title">DEPOSIT LOG</span></div>
          <div id="deposit-log-rows">
            {deposits.map((d, i) => {
              const a = agentFor(d.beneficiary);
              return (
                <div className="syn-row" key={i}>
                  <span className="syn-row__tx">#{i + 1}</span>
                  <span className="syn-row__kind">{a?.agentId || 'ESCROW_DEPOSIT'}</span>
                  <span className="syn-row__to">{truncateAddress(d.beneficiary)}</span>
                  <span className="syn-row__amount" style={{ flex: '0 0 84px', textAlign: 'right' }}>${formatUsdc(d.amount)}</span>
                  {a?.agentId && <TxHashLink chainId={sel} kind="deposit" refId={a.agentId} />}
                  {/* Same helper the slot cards use, so the log cannot disagree with them. */}
                  <span className={payout(d).tag}>{payout(d).label}</span>
                </div>
              );
            })}
            {ag.settled && (
              <div className="syn-row">
                <span className="syn-row__tx">tx</span>
                <span className="syn-row__kind">payout transaction</span>
                <span className="syn-row__to">Base Sepolia</span>
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
        </div>
      )}

      {ids.length === 0 && <p className="syn-sub">No agreements funded yet.</p>}
    </section>
  );
}
