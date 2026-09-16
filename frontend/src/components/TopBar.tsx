import { useBalance } from 'wagmi';
import { useApp, View } from '../context/AppContext';
import { useWallet } from '../hooks/useWallet';
import { truncateAddress } from '../constants';

const CRUMB: Record<View, string> = {
  overview: 'OVERVIEW', agents: 'AGENTS', workflows: 'WORKFLOWS',
  escrow: 'ESCROW', reputation: 'REPUTATION', how: 'HOW IT WORKS',
};

export function TopBar() {
  const { view } = useApp();
  const w = useWallet();
  const { data: bal } = useBalance({ address: (w.address || undefined) as `0x${string}` | undefined, chainId: w.chainId, query: { enabled: w.isConnected } });

  return (
    <header className="syn-header">
      <div className="syn-crumb">WORKSPACE / <b>{CRUMB[view]}</b></div>
      <div className="syn-header__right">
        <div className="syn-network" data-network={w.network}>
          <span className="syn-network__dot" />
          <span className="syn-network__name">{w.networkName}</span>
          {w.isConnected && bal && (
            <span className="syn-network__balance">{Number(bal.formatted).toFixed(2)} {bal.symbol}</span>
          )}
        </div>
        {w.isConnected ? (
          <button type="button" className="syn-wallet" data-connected="true" onClick={() => w.disconnect()} title="Disconnect">
            {truncateAddress(w.address)}
          </button>
        ) : (
          <button type="button" className="syn-wallet" data-connected="false" onClick={w.connect}>
            Connect Wallet
          </button>
        )}
      </div>
    </header>
  );
}
