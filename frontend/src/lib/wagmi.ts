import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets';
import { studioDevnet } from 'genlayer-js/chains';
import { baseSepolia } from 'wagmi/chains';

export { baseSepolia };

// The node Synarch runs on. studioDevnet carries the right chain id (61997) and the
// GenLayer-specific metadata (consensus contract, validator defaults) that
// genlayer-js's writeContract needs to ABI-encode a transaction, so a hand-rolled
// viem defineChain() is not an option: it throws on the first real write.
// Its bundled rpcUrls point at studio-dev, a DIFFERENT node, so the URL is overridden
// here. This is the single source of truth: the genlayer client and the wallet client
// both read it, which is what keeps them from talking to two different nodes.
export const GENLAYER_RPC = 'https://studio-next.genlayer.com/api';

export const genlayerChain = {
  ...studioDevnet,
  name: 'GenLayer Studio Next',
  rpcUrls: { default: { http: [GENLAYER_RPC] } },
};

// Browser-extension wallets only, by design. Synarch signs on a custom network (chain
// 61997) that the wallet has to add before it can sign anything, which is a desktop
// extension flow in practice. Every installed wallet announces itself through EIP-6963,
// so MetaMask, Rabby, Coinbase and the rest are discovered and listed on their own; the
// entry below is the fallback for a wallet that only exposes window.ethereum.
//
// WalletConnect (mobile / QR) is deliberately NOT registered. It requires a project id
// from the WalletConnect dashboard, and without a real one its entry in the modal is a
// dead end: the relay answers 403 and the QR never connects. Offering nothing is better
// than offering a button that cannot work. To enable it later, get a project id, set it
// as projectId below and add walletConnectWallet to the list.
const WALLETCONNECT_PROJECT_ID = 'synarch-console-unused';

export const wagmiConfig = getDefaultConfig({
  appName: 'Synarch',
  projectId: WALLETCONNECT_PROJECT_ID,
  wallets: [{ groupName: 'Installed', wallets: [injectedWallet] }],
  chains: [genlayerChain, baseSepolia],
});
