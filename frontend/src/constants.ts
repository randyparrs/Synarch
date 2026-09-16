// Synarch on GenLayer Studio Next (chain 61997) + Base Sepolia, 2026-09-15.
// Same addresses the backend scripts and the relay use; keep them in sync.
export const AGENTS_ADDRESS = '0x21B2b9c92DB2582Aa2cAD02345632387EE34120f'; // SynarchAgents (GenLayer)
export const JUDGE_ADDRESS = '0x81aE27362Fd23c7cF1A1D9b26ff2052E492778a8'; // SynarchJudge (GenLayer)
export const ESCROW_ADDRESS = '0x7C12C58B7241924e18E8f1aAbD8F7a7E60c3e1FB'; // SynarchEscrow multi-culprit (Base Sepolia)
export const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // USDC test (Base Sepolia)

// Bridge transport (for best-effort cross-chain progress display).
export const BRIDGE_SENDER_ADDRESS = '0xffe709e5883f5E669D4aBa35d0544269b28ce3d4'; // GenLayer
export const FORWARDER_ADDRESS = '0xBCa1b17E4e392A7104f964a8426b7c3f945f288d'; // ZKsync Sepolia
export const ZKSYNC_RPC = 'https://sepolia.era.zksync.dev';

// Block explorers. The one for chain 61997 is NOT declared in the SDK's chain definition
// (it ships explorers for studionet, Bradbury and Asimov only), so it is set here from the
// live explorer, confirmed against a real transaction. txUrl still returns null for a
// network without an explorer, and TxHashLink falls back to a copyable hash in that case.
export const EXPLORER = {
  genlayer: 'https://explorer-studio-dev.genlayer.com' as string | null,
  base: 'https://sepolia.basescan.org',
  zksync: 'https://sepolia.explorer.zksync.io',
};

/** Explorer link for a tx hash, or null when that network has no explorer. */
export const txUrl = (network: 'genlayer' | 'base', hash: string): string | null =>
  network === 'base' ? `${EXPLORER.base}/tx/${hash}` : EXPLORER.genlayer && `${EXPLORER.genlayer}/tx/${hash}`;

/** Explorer link for a contract address, or null when that network has no explorer. */
export const addressUrl = (network: 'genlayer' | 'base', address: string): string | null =>
  network === 'base' ? `${EXPLORER.base}/address/${address}` : EXPLORER.genlayer && `${EXPLORER.genlayer}/address/${address}`;

// Base Sepolia (EVM) chain id, for wagmi network switching / reads.
export const BASE_SEPOLIA_ID = 84532;

// The default delegation order shown when opening a fresh workflow. The agent
// profiles themselves are always read live from the contract.
export const DEFAULT_PLAN = ['data-agent-mo', 'analyst-mo', 'researcher-mo', 'strategist-mo'];

// The only real, production agents are the "-mo" ids. Older ids without the
// suffix are test fixtures and must never surface in any tab. We still read the
// full list from get_agent_ids() on-chain and filter here, never hardcode.
export const isProdAgent = (agentId: string): boolean => agentId.toLowerCase().endsWith('-mo');

// Old e2e/test chains that must never appear in the UI (Workflows tab, Overview
// selector, nav count). Real workflows are created from Create Workflow with a
// "wf-" id; anything else is a backend test fixture. The explicit set is an
// override in case a "wf-" id ever needs hiding too.
export const HIDDEN_CHAIN_IDS = new Set<string>([
  'demo-pago', 'demo-cancel', 'demo-timeout', 'indep1', 'indep2', 'demo5',
]);
export const isVisibleChain = (chainId: string): boolean =>
  chainId.startsWith('wf-') && !HIDDEN_CHAIN_IDS.has(chainId);

/** reliability band → drives meter/score color + the card top hairline. */
export const reliabilityBand = (pct?: number): 'high' | 'warn' | 'low' => {
  if (pct === undefined) return 'high';
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'warn';
  return 'low';
};

// --- Base contract ABIs (verified against the deployed SynarchEscrow + USDC) ---
export const ESCROW_ABI = [
  { type: 'function', name: 'openAgreement', stateMutability: 'nonpayable', inputs: [{ name: 'agreementId', type: 'string' }, { name: 'client', type: 'address' }], outputs: [] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'agreementId', type: 'string' }, { name: 'beneficiary', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'refundTimeout', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'fundedAt', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAgreementIds', stateMutability: 'view', inputs: [], outputs: [{ type: 'string[]' }] },
  { type: 'function', name: 'getAgreement', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [
    { name: 'exists', type: 'bool' }, { name: 'settled', type: 'bool' }, { name: 'client', type: 'address' },
    { name: 'verdict', type: 'string' }, { name: 'culpableAgents', type: 'address[]' }, { name: 'total', type: 'uint256' }, { name: 'depositCount', type: 'uint256' },
  ] },
  { type: 'function', name: 'getDeposit', stateMutability: 'view', inputs: [{ type: 'string' }, { type: 'uint256' }], outputs: [
    { name: 'depositor', type: 'address' }, { name: 'beneficiary', type: 'address' }, { name: 'amount', type: 'uint256' },
  ] },
] as const;

export const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// --- small view helpers ---
export const truncateAddress = (addr?: string): string =>
  addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : (addr || '');

export const cx = (...classes: Array<string | false | null | undefined>): string =>
  classes.filter(Boolean).join(' ');

/** USDC has 6 decimals. Format a raw bigint to a human string. */
export const formatUsdc = (raw: bigint): string => (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
