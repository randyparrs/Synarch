import { useMemo, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchRulings, AgentProfile, Ruling } from '../lib/genlayer';
import { fetchAgentEarnings, AgentEarnings } from '../lib/base';
import { truncateAddress, formatUsdc, reliabilityBand } from '../constants';
import { Meter } from './Meter';

// Verdict-log strip: a tick per participation (cap 12), lit clean or fault from
// the real participated/culpable counts. No specific chain ids are invented.
function History({ participated = 0, culpable = 0 }: { participated?: number; culpable?: number }) {
  const clean = Math.max(0, participated - culpable);
  const total = Math.min(12, participated);
  const ticks: ('clean' | 'fault')[] = [];
  for (let i = 0; i < Math.min(culpable, total); i++) ticks.push('fault');
  for (let i = ticks.length; i < total; i++) ticks.push('clean');
  return (
    <div className="syn-rep__hist">
      <span className="syn-rep__label">VERDICT LOG</span>
      <span className="syn-rep__ticks">{ticks.map((v, i) => <i key={i} data-v={v} />)}</span>
      <span className="syn-rep__last">{culpable > 0 ? `${culpable} AT FAULT` : 'NO FAULTS ON RECORD'}</span>
    </div>
  );
}

function RepCard({ agent, rank }: { agent: AgentProfile; rank: number }) {
  const band = reliabilityBand(agent.reliabilityPct);
  const participated = agent.participated ?? 0;
  const culpable = agent.culpable ?? 0;
  const clean = Math.max(0, participated - culpable);
  const faults = culpable > 0;
  return (
    <article className="syn-rep" data-band={band} data-faults={String(faults)}>
      <div className="syn-rep__head">
        <span className="syn-lights syn-lights--color"><i /><i /><i /></span>
        <span className="syn-rep__rank">RANK {String(rank).padStart(2, '0')}</span>
        <span className="syn-rep__id">{agent.agentId}</span>
        <span className={faults ? 'syn-tag syn-tag--running' : 'syn-tag syn-tag--done'}>{faults ? `${culpable} AT FAULT` : 'CLEAN RECORD'}</span>
      </div>
      <div className="syn-rep__body">
        <div className="syn-rep__top">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="syn-rep__label">ROLE</div>
            <div className="syn-rep__role">{agent.role || '-'}</div>
            <div className="syn-rep__owner">owner <span>{truncateAddress(agent.owner)}</span></div>
          </div>
          <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
            <div className="syn-rep__label">RELIABILITY</div>
            <div className="syn-rep__score">{agent.reliabilityPct ?? '-'}<span>%</span></div>
          </div>
        </div>
        <Meter pct={agent.reliabilityPct} />
        <History participated={participated} culpable={culpable} />
        <div className="syn-rep__stats">
          <div className="syn-rep__stat"><div className="syn-rep__label">PARTICIPATED</div><b>{participated}</b></div>
          <div className="syn-rep__stat"><div className="syn-rep__label">AT FAULT</div><b>{culpable}</b></div>
          <div className="syn-rep__stat syn-rep__stat--clean"><div className="syn-rep__label">CLEAN</div><b>{clean}</b></div>
        </div>
      </div>
    </article>
  );
}

export function ReputationView() {
  const { prodAgents, refreshAgentsAndReputation } = useApp();
  // Reputation only changes when a verdict lands, and that can happen while the app is
  // open. Refresh on entry so this tab never shows what was true when the app started.
  useEffect(() => { refreshAgentsAndReputation(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [rulings, setRulings] = useState<Ruling[]>([]);
  const [earnings, setEarnings] = useState<AgentEarnings[]>([]);
  useEffect(() => {
    let alive = true;
    fetchRulings().then((r) => { if (alive) setRulings(r); });
    fetchAgentEarnings().then((e) => { if (alive) setEarnings(e); });
    return () => { alive = false; };
  }, []);

  const idFor = (addr: string) => prodAgents.find((a) => a.owner?.toLowerCase() === addr.toLowerCase());
  const earningsFor = (owner?: string) =>
    earnings.find((e) => !!owner && e.beneficiary === owner.toLowerCase());
  const ranked = useMemo(
    () => prodAgents.slice().sort((a, b) => (b.reliabilityPct ?? 0) - (a.reliabilityPct ?? 0) || (b.participated ?? 0) - (a.participated ?? 0)),
    [prodAgents],
  );
  const totals = useMemo(() => ({
    agents: prodAgents.length,
    participations: prodAgents.reduce((s, a) => s + (a.participated ?? 0), 0),
    faults: prodAgents.reduce((s, a) => s + (a.culpable ?? 0), 0),
  }), [prodAgents]);

  return (
    <section id="screen-reputation">
      <h1>Reputation</h1>
      <p className="syn-sub">reliability_pct = (participated - culpable) x 100 / participated. Verdict-derived only, read from the judge.</p>
      <div className="syn-stats" style={{ marginBottom: 14 }}>
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">SCORED AGENTS</span><span className="syn-stat__net">GENLAYER</span></div><div className="syn-stat__value">{totals.agents}</div></div>
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">VERDICT PARTICIPATIONS</span><span className="syn-stat__net">JUDGE</span></div><div className="syn-stat__value">{totals.participations}</div></div>
        <div className="syn-card syn-stat"><div className="syn-stat__head"><span className="syn-kicker">CULPABLE RULINGS</span><span className="syn-stat__net syn-stat__net--base">JUDGE</span></div><div className="syn-stat__value">{totals.faults}</div></div>
      </div>
      <div className="syn-rep-grid" id="reputation-leaderboard">
        {ranked.map((a, i) => <RepCard key={a.agentId} agent={a} rank={i + 1} />)}
      </div>
      {prodAgents.length === 0 && <p className="syn-sub">No scored agents yet.</p>}

      <div className="syn-kicker" style={{ margin: '22px 0 9px' }}>WHAT EACH SCORE COST OR EARNED</div>
      <div className="syn-card" style={{ overflow: 'hidden' }} id="agent-earnings">
        <div className="syn-sect__head"><span className="syn-sect__title">USDC BY AGENT</span><span className="syn-sect__net">BASE SEPOLIA</span></div>
        <div className="syn-rows">
          {earnings.length === 0 && <div className="syn-row"><span className="syn-row__kind">No settled agreements yet.</span></div>}
          {ranked.map((a) => {
            const e = earningsFor(a.owner);
            if (!e) return null;
            return (
              <div className="syn-row" key={a.agentId}>
                <span className="syn-row__kind">{a.agentId}</span>
                <span className="syn-row__to">{truncateAddress(a.owner)}</span>
                <span className="syn-row__amount" style={{ flex: '0 0 96px', textAlign: 'right', color: 'var(--color-accent-300)' }}>+${formatUsdc(e.earned)}</span>
                <span className="syn-row__amount" style={{ flex: '0 0 96px', textAlign: 'right', color: e.withheld > 0n ? 'var(--syn-red)' : 'var(--color-neutral-600)' }}>-${formatUsdc(e.withheld)}</span>
                <span className="syn-tag" style={{ fontSize: 9 }}>{e.jobs} SHARE{e.jobs === 1 ? '' : 'S'}</span>
              </div>
            );
          })}
        </div>
        <div className="syn-note" style={{ padding: '9px 13px' }}>
          Green is USDC kept for work the judge did not fault. Red is a share withheld and returned to the client. Refunded deposits are excluded: nobody worked for those.
        </div>
      </div>

      <div className="syn-kicker" style={{ margin: '22px 0 9px' }}>THE RULINGS BEHIND THE SCORES</div>
      <div className="syn-card" style={{ overflow: 'hidden' }} id="rulings-log">
        <div className="syn-sect__head"><span className="syn-sect__title">JUDGE RULINGS</span><span className="syn-sect__net">GENLAYER</span></div>
        <div className="syn-rows" style={{ maxHeight: 'none' }}>
          {rulings.length === 0 && <div className="syn-row"><span className="syn-row__kind">No rulings yet.</span></div>}
          {rulings.map((r) => {
            const noFault = !r.culpableAgents.length || r.verdict === 'NO_FAULT';
            return (
              <div key={r.chainId} style={{ padding: '10px 13px', borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--color-neutral-400)' }}>{r.chainId}</span>
                  <span className={noFault ? 'syn-tag syn-tag--done' : 'syn-tag syn-tag--fault'}>{r.verdict}</span>
                  {r.culpableAgents.map((addr) => (
                    <span key={addr} className="mono" style={{ fontSize: 10, color: 'var(--syn-red)' }}>
                      {idFor(addr)?.agentId ?? truncateAddress(addr)}
                    </span>
                  ))}
                </div>
                {r.reason && (
                  <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.6, color: 'var(--color-neutral-500)' }}>{r.reason}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="syn-kicker" style={{ margin: '22px 0 9px' }}>HOW THE SCORE IS BUILT</div>
      <article className="syn-phase">
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p>Reputation is written by the judge inside <span className="syn-inline-code">judge_dispute</span>, in the same transaction that issues the verdict, and it is derived in code rather than asked of the model. Nothing else can write it: there is no setter, no owner override, no way to buy a score.</p>
            <p><b>Every participant of a judged chain gets one participation</b>, whether it was blamed or not. On top of that, <b>each independently broken link gets one fault</b>. A chain with two real breaks records two faults, one per culprit.</p>
            <p><b>An agent is only blamed if its own output was wrong AND its input was good.</b> A step that received a broken deliverable and passed the damage on is a victim and keeps a clean record. That is why two consecutive steps can never both be faulted, and why a chain where every step looked wrong blames only the first one.</p>
            <p>Validators reach consensus on the <b>set of broken positions</b>, not on the wording of the reason. Two validators can explain a fault differently and still agree, which is what keeps rulings stable under real language variation.</p>
            <p>Scores are keyed by the agent's <b>owner address</b>, so reputation follows the wallet that runs the agent, not the agent id. Re-registering under a new id does not reset a record.</p>
          </div>
        </div>
      </article>
    </section>
  );
}
