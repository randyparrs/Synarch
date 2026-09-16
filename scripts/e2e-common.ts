/**
 * Shared helpers for the Synarch e2e scripts: a GenLayer client with a resilient
 * send() (retries -32005 and transient reverts, spaces out txs) and the deployed
 * addresses. Import from the e2e-*.ts scripts.
 */
import { createAccount, createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';
import { TransactionStatus, type TransactionHash } from 'genlayer-js/types';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Deployed Synarch contracts on GenLayer Studio Next (chain 61997, redeployed 2026-09-15
// with a fixed deployer so the owner-gated setters stay reachable).
export const AGENTS = '0x21B2b9c92DB2582Aa2cAD02345632387EE34120f' as `0x${string}`;
export const JUDGE = '0x81aE27362Fd23c7cF1A1D9b26ff2052E492778a8' as `0x${string}`;
export const ESCROW = '0x7C12C58B7241924e18E8f1aAbD8F7a7E60c3e1FB'; // Base Sepolia, multi-culprit (address[])
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia
// Multi-owner agents (each owned by its own wallet), 4-link chain incl. the Strategist.
export const AGENT_IDS = ['data-agent-mo', 'analyst-mo', 'researcher-mo', 'strategist-mo'];

export const RPC = process.env.GENLAYER_RPC_URL || 'https://studio-next.genlayer.com/api';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function genlayer() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('Missing PRIVATE_KEY (synarch/scripts/.env)');
  const account = createAccount(pk as `0x${string}`);
  const me = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`).address;
  const client = createClient({
    chain: studioDevnet, // 61997
    endpoint: RPC,
    account,
  });

  // genlayer-js 2.x requires explicit fees on every write, and the estimate must be made
  // PER CALL, not once per process. A method that emits a cross-chain message (the judge's
  // dispatch_verdict, the agents' refunds) needs that message declared in messageAllocations;
  // a generic estimate returns none and the VM rejects the tx with `fee no_matching_allocation`.
  // estimateTransactionFeesForWrite simulates the actual call and derives what it needs.
  async function feesFor(address: `0x${string}`, fn: string, args: any[]) {
    const est: any = await (client as any).estimateTransactionFeesForWrite({
      address,
      functionName: fn,
      args,
    });
    const fees: any = { distribution: est.distribution, feeValue: est.feeValue };
    if (est.messageAllocations?.length) fees.messageAllocations = est.messageAllocations;
    return fees;
  }

  // Resilient write: the node under load returns -32005, intermittent reverts, receipt
  // timeouts, and occasionally an HTML gateway page instead of JSON.
  async function send(address: `0x${string}`, fn: string, args: any[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        const f = await feesFor(address, fn, args);
        const hash = await client.writeContract({ address, functionName: fn, args, value: 0n, fees: f });
        await client.waitForTransactionReceipt({ hash: hash as TransactionHash, status: TransactionStatus.ACCEPTED, retries: 40 });
        await sleep(3500);
        return hash as string;
      } catch (e: any) {
        const msg = String(e?.message || e);
        const transient = /-32005|-32006|capacity|slots occupied|rate limit|too many requests|reverted|was reverted|timed out|not valid JSON|DOCTYPE/i.test(msg);
        // A rate limit is counted per minute: a short backoff just burns another request.
        const rateLimited = /rate limit|too many requests/i.test(msg);
        if (transient && attempt < 12) {
          const wait = rateLimited ? Math.min(20000 + 10000 * attempt, 45000) : Math.min(20000, 2500 * attempt);
          console.log(`    (transient, retry ${attempt} in ${wait}ms): ${msg.slice(0, 90)}`);
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
  }

  const read = (address: `0x${string}`, fn: string, args: any[] = []) =>
    client.readContract({ address, functionName: fn, args });

  return { client, send, read, me };
}
