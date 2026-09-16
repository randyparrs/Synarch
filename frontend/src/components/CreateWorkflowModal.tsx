import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useWallet } from '../hooks/useWallet';
import { openChain } from '../lib/genlayer';
import { openAgreement, approveUsdc, deposit, usdcRaw, getAgreement, usdcBalanceOf } from '../lib/base';
import { cx, formatUsdc } from '../constants';

// Selection is capped at 4; the visible list is the shared production ("-mo")
// set from context, so it matches every other tab.
const MAX_AGENTS = 4;

const CloseIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z"/></svg>);

export function CreateWorkflowModal() {
  const { createOpen, closeCreate, agents, prodAgents, reloadChainIds, reloadAgents, openChainInOverview, recordTx } = useApp();
  const w = useWallet();

  const [agreement, setAgreement] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [depositPer, setDepositPer] = useState('0.25');
  const [draftId, setDraftId] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState('');
  const [err, setErr] = useState('');
  const [log, setLog] = useState<string[]>([]);

  // Only the production "-mo" agents are shown/selectable (shared source).
  const visibleAgents = prodAgents;

  // Fresh draft id + default plan each time the modal opens.
  useEffect(() => {
    if (createOpen) {
      setDraftId('wf-' + Date.now().toString(36));
      setSelected(prodAgents.slice(0, 2).map((a) => a.agentId));
      setLog([]); setRunning(false); setDone(''); setErr('');
    }
  }, [createOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = selected.length;
  const atMax = count >= MAX_AGENTS;
  const total = useMemo(() => (parseFloat(depositPer || '0') * count).toFixed(2), [depositPer, count]);
  const push = (m: string) => setLog((l) => [...l, m]);

  function toggle(agentId: string) {
    setSelected((s) => {
      if (s.includes(agentId)) return s.filter((x) => x !== agentId);
      if (s.length >= MAX_AGENTS) return s; // block the 5th pick
      return [...s, agentId];
    });
  }

  async function submit() {
    if (!w.isConnected) return w.connect();
    if (count === 0) return push('Pick at least one agent.');
    if (!agreement.trim()) return push('Write the agreement.');
    if (parseFloat(depositPer) <= 0) return push('Deposit per agent must be > 0.');

    setRunning(true); setLog([]); setDone(''); setErr('');
    const chainId = draftId;
    const client = w.address as `0x${string}`;
    const per = usdcRaw(depositPer);
    const need = per * BigInt(count);

    // 0) HARD GATE, before ANYTHING is signed: confirm the client can fund the
    // whole deposit on Base. Fail-closed: if the balance is short OR we cannot
    // read it, stop here and create nothing (no open_chain, no agreement).
    try {
      push('Checking USDC balance on Base…');
      const bal = await usdcBalanceOf(client);
      if (bal < need) {
        setErr(`Insufficient USDC in Base Sepolia: you have $${formatUsdc(bal)}, this workflow needs $${total}. Nothing was created. Fund your wallet (see How it works) and try again.`);
        push(`Blocked: insufficient USDC (have $${formatUsdc(bal)}, need $${total}). Nothing was created.`);
        setRunning(false);
        return;
      }
      push(`Balance OK: $${formatUsdc(bal)} available, $${total} needed.`);
    } catch (e: any) {
      setErr('Could not verify your USDC balance on Base Sepolia, so nothing was created. Check your connection and try again.');
      push('Blocked: USDC balance read failed. ' + String(e?.message || e).slice(0, 120));
      setRunning(false);
      return;
    }

    try {
      // 1) GenLayer: register the delegation chain.
      push('1/4 open_chain on GenLayer…');
      if (!w.onGenLayer) await w.switchToGenLayer();
      const openHash = await openChain(client, chainId, agreement.trim(), client, selected);
      recordTx({ chainId, kind: 'open_chain', label: 'Open chain', network: 'genlayer', hash: openHash });

      // 2) Base: bind the agreement, approve, deposit per agent.
      push('Switching to Base Sepolia…');
      await w.switchToBase();

      const ex = await getAgreement(chainId).catch(() => null);
      if (!ex?.exists) { push('2/4 openAgreement on Base…'); const h = await openAgreement(chainId, client); recordTx({ chainId, kind: 'open_agreement', label: 'Open agreement', network: 'base', hash: h }); }
      else push('2/4 agreement already open, skipping.');

      push('3/4 approve USDC…');
      const approveHash = await approveUsdc(need);
      recordTx({ chainId, kind: 'approve', label: 'Approve USDC', network: 'base', hash: approveHash });

      push('4/4 deposit per agent…');
      for (const agentId of selected) {
        const owner = agents.find((a) => a.agentId === agentId)?.owner as `0x${string}` | undefined;
        if (!owner) { push(`  skip ${agentId}: no owner`); continue; }
        const dHash = await deposit(chainId, owner, per);
        recordTx({ chainId, kind: 'deposit', label: `Deposit → ${agentId}`, network: 'base', hash: dHash, ref: agentId });
        push(`  deposited to ${agentId}`);
      }

      push(`Done. Chain ${chainId} created and funded.`);
      await reloadChainIds(); await reloadAgents();
      setDone(chainId);
    } catch (e: any) {
      push('Failed: ' + String(e?.message || e).slice(0, 180));
    } finally { setRunning(false); }
  }

  if (!createOpen) return null;

  return (
    <div className="syn-modal" role="dialog" aria-modal="true">
      <div className="syn-modal__window">
        <div className="syn-modal__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>Create workflow</h1>
            <p className="syn-sub" style={{ margin: 0 }}>One chain call on GenLayer, then openAgreement + approve + one deposit per agent on Base.</p>
          </div>
          <button type="button" className="syn-modal__close" aria-label="Close" onClick={closeCreate}><CloseIcon /></button>
        </div>

        <form className="syn-modal__grid" onSubmit={(e) => e.preventDefault()}>
          <div className="syn-card" style={{ padding: 16 }}>
            <div className="syn-field">
              <label htmlFor="agreement-input">Agreement: what the chain must deliver</label>
              <textarea className="syn-input syn-input--composer" id="agreement-input" value={agreement} onChange={(e) => setAgreement(e.target.value)}
                placeholder="Describe what the chain must deliver. State it so the outcome can be checked against reality, since that is what the judge compares the work against if you dispute it." />
            </div>
            <div className="syn-kicker" style={{ marginBottom: 8 }}>DELEGATION ORDER <span style={{ color: 'var(--color-neutral-600)', fontWeight: 400 }}>· up to {MAX_AGENTS}</span></div>
            <div id="delegation-order">
              {visibleAgents.map((a) => {
                const order = selected.indexOf(a.agentId);
                const picked = order >= 0;
                const blocked = !picked && atMax; // 4 already chosen
                return (
                  <button type="button" key={a.agentId} className={cx('syn-pick', picked && 'is-picked')} aria-pressed={picked} disabled={blocked} style={blocked ? { opacity: 0.4, cursor: 'not-allowed' } : undefined} onClick={() => toggle(a.agentId)}>
                    <span className="syn-pick__order">{picked ? order + 1 : '+'}</span>
                    <span className="syn-pick__id">{a.agentId}</span>
                    <span className="syn-pick__role">{a.role}</span>
                    <span className="syn-pick__rel">{a.reliabilityPct !== undefined ? `${a.reliabilityPct}%` : '-'}</span>
                  </button>
                );
              })}
            </div>
            <div className="syn-field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label htmlFor="deposit-per-agent">Deposit per agent (USDC)</label>
              <input className="syn-input" id="deposit-per-agent" type="text" inputMode="decimal" value={depositPer} onChange={(e) => setDepositPer(e.target.value)} />
            </div>
          </div>

          <div className="syn-card" style={{ padding: 16, alignSelf: 'start' }}>
            <div className="syn-kicker" style={{ marginBottom: 11 }}>TRANSACTION PLAN</div>
            <div id="transaction-plan">
              <div className="syn-tx"><span className="syn-tx__n">1</span><div style={{ flex: 1, minWidth: 0 }}><div className="syn-tx__call">agents.open_chain(chain_id, agreement, client, [ids])</div><div className="syn-tx__note">Registers the delegation order</div></div><span className="syn-tag syn-tag--done">GENLAYER</span></div>
              <div className="syn-tx"><span className="syn-tx__n">2</span><div style={{ flex: 1, minWidth: 0 }}><div className="syn-tx__call">escrow.openAgreement(chain_id, client)</div><div className="syn-tx__note">Binds the same id to the money side</div></div><span className="syn-tag">BASE</span></div>
              <div className="syn-tx"><span className="syn-tx__n">3</span><div style={{ flex: 1, minWidth: 0 }}><div className="syn-tx__call">USDC.approve(escrow, total)</div><div className="syn-tx__note">One approval for the whole chain</div></div><span className="syn-tag">BASE</span></div>
              <div className="syn-tx"><span className="syn-tx__n">4</span><div style={{ flex: 1, minWidth: 0 }}><div className="syn-tx__call">escrow.deposit(chain_id, agentOwner, amount) × {count}</div><div className="syn-tx__note">One deposit per agent beneficiary</div></div><span className="syn-tag">BASE</span></div>
            </div>
            <div className="syn-total"><span className="syn-total__label">Total deposit</span><span className="syn-total__value">${total}</span></div>
            {err && (
              <div role="alert" style={{ marginTop: 12, padding: '9px 11px', borderRadius: 'var(--radius-md)', border: '1px solid #7a3a3f', background: '#2a1618', color: 'var(--syn-red)', fontSize: 11.5, lineHeight: 1.5 }}>{err}</div>
            )}
            {done ? (
              <>
                <div role="status" style={{ marginTop: 12, padding: '9px 11px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-accent-700)', background: '#14251c', color: 'var(--color-accent-200)', fontSize: 11.5, lineHeight: 1.5 }}>
                  Workflow created and funded on Base. Chain {done} is now active in Overview.
                </div>
                <button type="button" className="syn-btn syn-btn--block" style={{ marginTop: 10 }} onClick={() => { openChainInOverview(done); closeCreate(); }}>
                  View workflow →
                </button>
              </>
            ) : (
              <button type="button" className="syn-btn syn-btn--block" style={{ marginTop: 12 }} disabled={running} onClick={submit}>
                {running ? 'Working…' : w.isConnected ? 'Open chain & deposit' : 'Connect wallet'}
              </button>
            )}
            <div className="syn-chainid">chain_id = agreementId = dispute_id → <span>{draftId}</span></div>
            {log.length > 0 && (
              <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', fontSize: 11, color: 'var(--color-neutral-300)', maxHeight: 180, overflow: 'auto' }}>{log.join('\n')}</pre>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
