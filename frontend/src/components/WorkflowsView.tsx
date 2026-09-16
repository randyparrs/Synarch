import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchChain } from '../lib/genlayer';
import { getAgreement } from '../lib/base';
import { truncateAddress, formatUsdc } from '../constants';

interface Row {
  chainId: string;
  agreement: string;
  client: string;
  status: string;       // contract-level: open | complete | cancelled
  stepsDone: number;
  stepsTotal: number;
  escrowTotal: bigint;
  settled: boolean;
  verdict: string;
  exists: boolean;
}

type WfState = 'running' | 'settled' | 'refunded' | 'cancelled';

function wfState(r: Row): WfState {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.settled) return r.verdict === 'REFUNDED' ? 'refunded' : 'settled';
  return 'running';
}
const stateTag: Record<WfState, { label: string; cls: string }> = {
  running: { label: 'RUNNING', cls: 'syn-tag syn-tag--running' },
  settled: { label: 'SETTLED', cls: 'syn-tag syn-tag--done' },
  refunded: { label: 'REFUNDED', cls: 'syn-tag syn-tag--waiting' },
  cancelled: { label: 'CANCELLED', cls: 'syn-tag syn-tag--waiting' },
};

function Track({ r, st }: { r: Row; st: WfState }) {
  const n = Math.max(r.stepsTotal, 1);
  return (
    <div className="syn-wf__track" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        let s: string;
        if (st === 'cancelled') s = 'void';
        else if (i < r.stepsDone) s = 'done';
        else if (i === r.stepsDone && st === 'running') s = 'active';
        else s = 'pending';
        return <i key={i} data-state={s} />;
      })}
    </div>
  );
}

export function WorkflowsView() {
  const { chainIds, openChainInOverview, setView } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (chainIds.length === 0) { setRows([]); return; }
      setLoading(true);
      try {
        const out = await Promise.all(chainIds.map(async (chainId): Promise<Row> => {
          const [c, a] = await Promise.all([
            fetchChain(chainId).catch(() => null),
            getAgreement(chainId).catch(() => null),
          ]);
          return {
            chainId,
            agreement: c?.agreement || '-',
            client: c?.client || a?.client || '',
            status: c?.status || 'open',
            stepsDone: c?.stepsDone ?? 0,
            stepsTotal: c?.stepsTotal ?? 0,
            escrowTotal: a?.total ?? 0n,
            settled: a?.settled ?? false,
            verdict: a?.verdict || '',
            exists: a?.exists ?? false,
          };
        }));
        if (alive) setRows(out.reverse());
      } catch (e) { console.error('workflows load', e); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [chainIds]);

  return (
    <section id="screen-workflows">
      <h1>Workflows</h1>
      <p className="syn-sub">Derived state: agents, judge and escrow unified per chain_id.</p>
      {loading && rows.length === 0 && <p className="syn-sub">Loading workflows…</p>}
      <div className="syn-wf-grid" id="workflows-rows">
        {rows.map((r) => {
          const st = wfState(r);
          const net = r.settled ? 'BASE' : 'GENLAYER';
          return (
            <article className="syn-wf" key={r.chainId} data-state={st}>
              <div className="syn-wf__head">
                <span className="syn-lights syn-lights--color"><i /><i /><i /></span>
                <span className="syn-wf__id">{r.chainId}</span>
                <span className="syn-wf__net">{net}</span>
                <span className={stateTag[st].cls}>{stateTag[st].label}</span>
              </div>
              <div className="syn-wf__body">
                <div className="syn-wf__agreement">{r.agreement}</div>
                <Track r={r} st={st} />
                <div className="syn-wf__stats">
                  <div><span className="syn-astat__label">PROGRESS</span><b>{r.stepsDone}/{r.stepsTotal}</b></div>
                  <div><span className="syn-astat__label">ESCROW</span><b>${formatUsdc(r.escrowTotal)}</b></div>
                  <div><span className="syn-astat__label">CLIENT</span><b>{truncateAddress(r.client)}</b></div>
                </div>
                <div className="syn-wf__actions">
                  <button type="button" className="syn-btn syn-btn--secondary" onClick={() => openChainInOverview(r.chainId)}>Open in Overview</button>
                  {r.settled
                    ? <button type="button" className="syn-btn syn-btn--ghost" onClick={() => setView('escrow')}>Settlement receipt</button>
                    : <button type="button" className="syn-btn syn-btn--ghost" onClick={() => setView('escrow')}>Escrow</button>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {!loading && rows.length === 0 && <p className="syn-sub">No workflows yet. Create one from the sidebar.</p>}
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--color-neutral-600)' }}>Select the active chain to drive it from Overview: run, dispute and settle live there.</div>
    </section>
  );
}
