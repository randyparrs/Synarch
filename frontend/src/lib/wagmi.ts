import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { fallback, http } from 'viem';
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

// Base Sepolia reads (escrow, USDC, settlement logs) used to go through a single public
// endpoint, and this console polls: every open tab re-reads the agreement, its deposits and
// the escrow balance every 20 seconds. One node answering that for every visitor at once is
// the first thing to rate-limit when more than a couple of people open the site, and a 429
// here shows up as an empty settlement hash rather than an error.
// Two independent public nodes are declared instead: viem sends to the first and falls back
// to the second when it errors or times out. Both were checked against the 4500-block
// getLogs range this app actually uses, which is the constraint that rules a node out (a
// free plan that caps the range cannot serve the ledger, however fast it answers).
export const BASE_RPC_URLS = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
];

export const baseTransport = fallback(BASE_RPC_URLS.map((url) => http(url)));

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
  transports: {
    [genlayerChain.id]: http(GENLAYER_RPC),
    [baseSepolia.id]: baseTransport,
  },
});
