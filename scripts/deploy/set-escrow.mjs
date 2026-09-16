// Point a GenLayer contract (judge or agents) at the deployed escrow on Base.
//
// Both contracts expose set_escrow_contract(address, target_chain_eid), gated to the
// owner/admin set at deploy time. Reads the config before and after so the change is
// visible rather than assumed.
//
// Usage, from scripts/:
//   node deploy/set-escrow.mjs <genlayer_contract> <escrow_address> [eid]
//   GL_READ=1 node deploy/set-escrow.mjs <genlayer_contract>     # read the config only

import { createClient, createAccount } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.SYNARCH_ENV || resolve(HERE, "..", ".env");
const RPC = process.env.GENLAYER_RPC_URL || "https://studio-next.genlayer.com/api";

function privateKey() {
  const line = readFileSync(ENV_PATH, "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
  if (!line) throw new Error(`PRIVATE_KEY not found in ${ENV_PATH}`);
  const match = line.match(/0x[0-9a-fA-F]{64}/);
  if (!match) throw new Error("PRIVATE_KEY is present but is not 0x + 64 hex characters");
  return match[0];
}

const [contract, escrow, eidArg] = process.argv.slice(2);
if (!contract) {
  console.error("Usage: node deploy/set-escrow.mjs <genlayer_contract> <escrow_address> [eid]");
  process.exit(1);
}

const client = createClient({ chain: studioDevnet, endpoint: RPC, account: createAccount(privateKey()) });
const config = () => client.readContract({ address: contract, functionName: "get_config", args: [] });

console.log("before:", JSON.stringify(await config()));
if (process.env.GL_READ) process.exit(0);
if (!escrow) throw new Error("Missing <escrow_address>");

const fees = await client.estimateTransactionFeesForWrite({
  address: contract,
  functionName: "set_escrow_contract",
  args: [escrow, Number(eidArg ?? 40245)],
});
const feeOptions = { distribution: fees.distribution, feeValue: fees.feeValue };
if (fees.messageAllocations?.length) feeOptions.messageAllocations = fees.messageAllocations;

const tx = await client.writeContract({
  address: contract,
  functionName: "set_escrow_contract",
  args: [escrow, Number(eidArg ?? 40245)],
  fees: feeOptions,
});
await client.waitForTransactionReceipt({ hash: tx, waitUntil: "finalized", interval: 3000, retries: 300 });
console.log("transaction:", tx);
console.log("after: ", JSON.stringify(await config()));
