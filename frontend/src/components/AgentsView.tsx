import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { previewPrompt, AgentProfile } from '../lib/genlayer';
import { truncateAddress, reliabilityBand } from '../constants';
import { Meter } from './Meter';

const slot = (i: number) => String(i + 1).padStart(2, '0');
const PREVIEW_REQUEST = '[the task you submit when you create a workflow]';
const CloseIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z" /></svg>);

function AgentCard({ agent, index, onPreview, loading }: { agent: AgentProfile; index: number; onPreview: (a: AgentProfile) => void; loading: boolean }) {
  const band = reliabilityBand(agent.reliabilityPct);
  return (
    <article className="syn-card syn-agent-card" data-band={band}>
      <div className="syn-agent-card__top"><span className="syn-agent-card__id">{agent.agentId}</span><span className="syn-tag syn-tag--done">GENLAYER</span></div>
      <div className="syn-agent-card__role">{agent.role || '-'}</div>

      <div className="syn-astat">
        <div className="syn-astat__row"><span className="syn-astat__label">RELIABILITY</span><span className="syn-astat__val">{agent.reliabilityPct ?? '-'}<span>%</span></span></div>
        <Meter pct={agent.reliabilityPct} sm />
        <div className="syn-astat__grid">
          <div><span className="syn-astat__label">JOBS</span><b>{agent.participated ?? 0}</b></div>
          <div><span className="syn-astat__label">AT FAULT</span><b>{agent.culpable ?? 0}</b></div>
          <div><span className="syn-astat__label">CHAIN SLOT</span><b>{slot(index)}</b></div>
        </div>
      </div>

      <div className="syn-agent-card__foot"><span className="syn-astat__label">OWNER</span><span style={{ flex: 1 }}>{truncateAddress(agent.owner)}</span></div>
      <div className="syn-agent-card__actions">
        <button type="button" className="syn-btn syn-btn--secondary" style={{ flex: 1 }} disabled={loading} onClick={() => onPreview(agent)}>{loading ? 'Reading…' : 'Preview prompt'}</button>
      </div>
    </article>
  );
}

export function AgentsView() {
  const { prodAgents, agentsLoading } = useApp();
  const [loadingId, setLoadingId] = useState('');
  const [modal, setModal] = useState<{ agent: AgentProfile; text: string } | null>(null);

  async function openPreview(agent: AgentProfile) {
    setLoadingId(agent.agentId);
    try {
      const text = await previewPrompt(agent.agentId, PREVIEW_REQUEST);
      setModal({ agent, text });
    } catch (e: any) {
      setModal({ agent, text: 'Failed to read prompt: ' + String(e?.message || e).slice(0, 160) });
    } finally { setLoadingId(''); }
  }

  return (
    <section id="screen-agents">
      <h1>Agent directory</h1>
      <p className="syn-sub">Every profile and reputation score is read from GenLayer Studio Next.</p>
      {agentsLoading && prodAgents.length === 0 && <p className="syn-sub">Loading agents…</p>}
      <div className="syn-agent-grid" id="agent-list">
        {prodAgents.map((a, i) => <AgentCard key={a.agentId} agent={a} index={i} onPreview={openPreview} loading={loadingId === a.agentId} />)}
      </div>
      {!agentsLoading && prodAgents.length === 0 && <p className="syn-sub">No agents registered on-chain.</p>}

      {modal && (
        <div className="syn-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-title" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="syn-modal__window" style={{ width: 'min(640px, 100%)' }}>
            <div className="syn-modal__head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 id="prompt-title">Preview prompt</h1>
                <p className="syn-sub" style={{ margin: 0 }}>{modal.agent.agentId} - {modal.agent.role} - read from agents.preview_prompt</p>
              </div>
              <button type="button" className="syn-modal__close" aria-label="Close" onClick={() => setModal(null)}><CloseIcon /></button>
            </div>
            <pre style={{ margin: 0, padding: '12px 13px', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--color-neutral-300)', background: '#101312', border: '1px solid var(--color-neutral-900)', borderRadius: 'var(--radius-md)', maxHeight: '60vh', overflow: 'auto' }}>{modal.text}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
