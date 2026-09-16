import { useEffect, useState } from 'react';
import { useApp, View } from '../context/AppContext';
import { cx } from '../constants';
import { genlayerChain, GENLAYER_RPC } from '../lib/wagmi';

const HomeIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216 115.54V208a16 16 0 0 1-16 16h-40a8 8 0 0 1-8-8v-52a4 4 0 0 0-4-4h-40a4 4 0 0 0-4 4v52a8 8 0 0 1-8 8H56a16 16 0 0 1-16-16v-92.46a16 16 0 0 1 5.17-11.78l80-75.48a16 16 0 0 1 21.66 0l80 75.48A16 16 0 0 1 216 115.54"/></svg>);
const AgentsIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M117.25 157.92a60 60 0 1 0-66.5 0 95.83 95.83 0 0 0-47.22 37.71 8 8 0 1 0 13.4 8.74 80 80 0 0 1 134.14 0 8 8 0 0 0 13.4-8.74 95.83 95.83 0 0 0-47.22-37.71M40 108a44 44 0 1 1 44 44 44.05 44.05 0 0 1-44-44m210.14 98.7a8 8 0 0 1-11.07-2.33A79.83 79.83 0 0 0 172 168a8 8 0 0 1 0-16 44 44 0 1 0-16.34-84.87 8 8 0 1 1-5.94-14.85 60 60 0 0 1 55.53 105.64 95.83 95.83 0 0 1 47.22 37.71 8 8 0 0 1-2.33 11.07"/></svg>);
const PlusIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m40 112h-32v32a8 8 0 0 1-16 0v-32H88a8 8 0 0 1 0-16h32V88a8 8 0 0 1 16 0v32h32a8 8 0 0 1 0 16"/></svg>);
const FlowIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M200 152a31.84 31.84 0 0 0-19.53 6.68l-23.11-18A31.65 31.65 0 0 0 160 128c0-.74 0-1.48-.08-2.21l13.23-4.41A32 32 0 1 0 168 104c0 .74 0 1.48.08 2.21l-13.23 4.41A32 32 0 0 0 128 96a32.6 32.6 0 0 0-5.27.44L115.89 81A32 32 0 1 0 96 88a32.6 32.6 0 0 0 5.27-.44l6.84 15.4a32 32 0 0 0 0 50.09l-6.84 15.4A32.6 32.6 0 0 0 96 168a32.05 32.05 0 1 0 19.89 7l6.84-15.4a32.6 32.6 0 0 0 5.27.44 31.65 31.65 0 0 0 12.69-2.64l23.11 18A32 32 0 1 0 200 152"/></svg>);
const EscrowIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216 64H56a8 8 0 0 1 0-16h144a8 8 0 0 0 0-16H56a24 24 0 0 0-24 24v144a24 24 0 0 0 24 24h160a16 16 0 0 0 16-16V80a16 16 0 0 0-16-16m-36 84a12 12 0 1 1 12-12 12 12 0 0 1-12 12"/></svg>);
const RepIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M232 64h-32V56a16 16 0 0 0-16-16H72a16 16 0 0 0-16 16v8H24a16 16 0 0 0-16 16v16a40 40 0 0 0 40 40h3.65A80.1 80.1 0 0 0 120 191.61V216H96a8 8 0 0 0 0 16h64a8 8 0 0 0 0-16h-24v-24.39A80.1 80.1 0 0 0 204.35 136H208a40 40 0 0 0 40-40V80a16 16 0 0 0-16-16M48 120a24 24 0 0 1-24-24V80h32v32q0 4 .39 8Zm184-24a24 24 0 0 1-24 24h-8.39q.39-4 .39-8V80h32Z"/></svg>);
const HowIcon = () => (<svg className="syn-icon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m0 168a12 12 0 1 1 12-12 12 12 0 0 1-12 12m8-48.72V144a8 8 0 0 1-16 0v-8a8 8 0 0 1 8-8c13.23 0 24-9 24-20s-10.77-20-24-20-24 9-24 20v4a8 8 0 0 1-16 0v-4c0-19.85 17.94-36 40-36s40 16.15 40 36c0 17.38-13.76 31.93-32 35.28"/></svg>);

/**
 * Live node status. One request per tick, every 20s: the node caps callers at 30 requests
 * per minute and the rest of the app also reads from it, so this stays deliberately cheap.
 *
 * On "NODE TIME": the Studio node answers eth_blockNumber with its own Unix clock, not a
 * block height (measured: it matches wall time to the second). Showing it as a ten digit
 * "block" was both wrong and unreadable, since only the last digits moved. It is rendered
 * as the time it actually is, and compared against this machine's clock: a node whose time
 * drifts breaks anything that depends on timestamps, such as the refund timeout.
 */
function NodeStatus() {
  const [state, setState] = useState<{ online: boolean; ms: number; nodeTime: number | null; drift: number }>({
    online: false, ms: 0, nodeTime: null, drift: 0,
  });

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const t0 = Date.now();
      try {
        const r = await fetch(GENLAYER_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        });
        const j = await r.json();
        if (!alive) return;
        const nodeTime = j?.result ? parseInt(j.result, 16) : null;
        const drift = nodeTime ? nodeTime - Math.floor(Date.now() / 1000) : 0;
        setState({ online: !j?.error, ms: Date.now() - t0, nodeTime, drift });
      } catch {
        if (alive) setState((p) => ({ ...p, online: false, ms: Date.now() - t0 }));
      }
    };
    ping();
    const id = window.setInterval(ping, 20000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="syn-nodestat">
      <div className="syn-nodestat__row">
        <span className="syn-nodestat__dot" data-online={state.online ? 'yes' : 'no'} />
        <span className="syn-nodestat__label">RPC</span>
        <span className="syn-nodestat__value" data-online={state.online ? 'yes' : 'no'}>
          {state.online ? 'ONLINE' : 'OFFLINE'}
        </span>
        <span className="syn-nodestat__ms">{state.ms ? `${state.ms}ms` : ''}</span>
      </div>
      <div className="syn-nodestat__row">
        <span className="syn-nodestat__label">CHAIN_ID</span>
        <span className="syn-nodestat__value">{genlayerChain.id}</span>
      </div>
      <div className="syn-nodestat__row">
        <span className="syn-nodestat__label">NODE TIME</span>
        <span className="syn-nodestat__value">
          {state.nodeTime === null
            ? '--'
            : new Date(state.nodeTime * 1000).toISOString().slice(11, 19)}
        </span>
        <span className="syn-nodestat__ms">
          {state.nodeTime === null ? '' : Math.abs(state.drift) <= 3 ? 'in sync' : `${state.drift > 0 ? '+' : ''}${state.drift}s`}
        </span>
      </div>
    </div>
  );
}

export function Sidebar() {
  const { view, setView, openCreate, prodAgents, chainIds } = useApp();
  const item = (v: View, label: string, icon: JSX.Element, count?: number) => (
    <button type="button" className={cx('syn-nav__item', view === v && 'is-active')} onClick={() => setView(v)}>
      {icon}<span className="syn-nav__label">{label}</span>
      {count !== undefined && <span className="syn-nav__count">{count}</span>}
    </button>
  );
  return (
    <aside className="syn-sidebar">
      <div className="syn-brand">
        <div className="syn-brand__mark"><span>S</span><span>_</span></div>
        <div className="syn-brand__name">SYNARCH</div>
      </div>
      <nav className="syn-nav" id="main-nav">
        {item('overview', 'Overview', <HomeIcon />)}
        {item('agents', 'Agents', <AgentsIcon />, prodAgents.length)}
        <button type="button" className="syn-nav__item" onClick={openCreate}>
          <PlusIcon /><span className="syn-nav__label">Create Workflow</span>
        </button>
        {item('workflows', 'Workflows', <FlowIcon />, chainIds.length)}
        {item('escrow', 'Escrow', <EscrowIcon />)}
        {item('reputation', 'Reputation', <RepIcon />)}
        {item('how', 'How it works', <HowIcon />)}
      </nav>
      <div style={{ flex: 1 }} />
      <NodeStatus />
    </aside>
  );
}
