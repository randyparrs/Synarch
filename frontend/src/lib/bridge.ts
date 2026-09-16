import { createPublicClient, http, decodeAbiParameters, isHex } from 'viem';
import { createClient } from 'genlayer-js';
import { genlayerChain, GENLAYER_RPC } from './wagmi';
import { BRIDGE_SENDER_ADDRESS, FORWARDER_ADDRESS, ZKSYNC_RPC, ESCROW_ADDRESS } from '../constants';

// Per-chain cross-chain bridge status, read entirely on-chain (no local flags):
//  - dispatched: a verdict message for THIS agreement is queued in the BridgeSender
//    (Judge.dispatch_verdict emitted it). The GenLayer emit is async, so this can lag
//    the Settle click by minutes; that latency is real cross-chain behavior.
//  - forwarded: the ZKsync forwarder consumed that message hash (LayerZero in flight).
// The definitive "paid" signal is escrow.getAgreement().settled, and the caller owns it.

const zk = createPublicClient({ transport: http(ZKSYNC_RPC) });
const IS_HASH_USED_ABI = [
  { type: 'function', name: 'isHashUsed', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;

export interface BridgeStatus { dispatched: boolean; forwarded: boolean; }

function toHex(data: unknown): `0x${string}` | null {
  if (typeof data === 'string') return (isHex(data) ? data : `0x${data.replace(/^0x/, '')}`) as `0x${string}`;
  if (Array.isArray(data)) return `0x${data.map((b) => Number(b).toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  return null;
}

// Decode a stored BridgeSender message to the dispute_id it carries, or null if it is
// not a verdict aimed at the CURRENT escrow. Shape verified on-chain:
//   outer: abi(uint32 tag, address sender, address target, bytes payload)  [selector stripped]
//   inner: abi(string dispute_id, string verdict, address[] culpables)
function disputeIdFor(data: unknown): string | null {
  const hex = toHex(data);
  if (!hex) return null;
  try {
    const [, , target, payload] = decodeAbiParameters(
      [{ type: 'uint32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }], hex);
    if (String(target).toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) return null; // ignore stale/other-escrow msgs
    const [disputeId] = decodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'address[]' }], payload as `0x${string}`);
    return disputeId as string;
  } catch { return null; }
}

// Cross-chain status for ONE agreement, derived from persistent on-chain reads only.
// Any failure returns {false,false} so a read hiccup just shows the earliest state,
// never a fake progress tick. escrow.settled (read by the caller) is the terminal authority.
export async function bridgeStatus(chainId: string): Promise<BridgeStatus> {
  try {
    const gl = createClient({ chain: genlayerChain as any, endpoint: GENLAYER_RPC });
    const messages = (await gl.readContract({ address: BRIDGE_SENDER_ADDRESS as `0x${string}`, functionName: 'get_messages', args: [] })) as Record<string, { data: unknown }>;
    let hash: string | null = null;
    for (const [h, m] of Object.entries(messages || {})) {
      if (disputeIdFor(m?.data) === chainId) { hash = h; break; }
    }
    if (!hash) return { dispatched: false, forwarded: false };
    const used = (await zk.readContract({ address: FORWARDER_ADDRESS as `0x${string}`, abi: IS_HASH_USED_ABI, functionName: 'isHashUsed', args: [`0x${hash.replace(/^0x/, '')}` as `0x${string}`] })) as boolean;
    return { dispatched: true, forwarded: !!used };
  } catch {
    return { dispatched: false, forwarded: false };
  }
}
