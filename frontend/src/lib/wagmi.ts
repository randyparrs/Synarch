import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { studioDevnet } from 'genlayer-js/chains';
import { baseSepolia } from 'wagmi/chains';

export { baseSepolia };

// The node Synarch runs on. studioDevnet carries the right chain id (61997) and the
// GenLayer-specific metadata (consensus contract, validator defaults) that
// genlayer-js's writeContract needs to ABI-encode a transaction, so a hand-rolled
// viem defineChain() is not an option: it throws on the first real write.
// Its bundled rpcUrls point at studio-dev, a DIFFERENT node, so the URL is overridden
// here. This is the single source of truth: the genlayer client and the wallet network
// both read it, which is what keeps them from talking to two different nodes.
export const GENLAYER_RPC = 'https://studio-next.genlayer.com/api';

export const genlayerChain = {
  ...studioDevnet,
  name: 'GenLayer Studio Next',
  rpcUrls: { default: { http: [GENLAYER_RPC] } },
};

// Injected wallets (MetaMask, Rabby, Coinbase extension, etc.) work without a
// WalletConnect Cloud project id. Add a real one from https://cloud.walletconnect.com
// to enable mobile/QR wallets via WalletConnect.
const WALLETCONNECT_PROJECT_ID = 'synarch-placeholder';

export const wagmiConfig = getDefaultConfig({
  appName: 'Synarch',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [genlayerChain, baseSepolia],
});
