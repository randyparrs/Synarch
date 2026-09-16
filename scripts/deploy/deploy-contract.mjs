// Deploy a GenLayer intelligent contract to Studio Next (chain 61997).
//
// The CLI does not attach transaction fees on this network and the node rejects a
// deploy without them, so fees are estimated and passed explicitly. The signing key is
// read from scripts/.env (PRIVATE_KEY) and never printed: it becomes the contract's
// owner/admin, which is what makes the owner-gated setters reachable afterwards.
//
// Usage, from scripts/:
//   node deploy/deploy-contract.mjs ../contracts/SynarchJudge.py
//   GL_ARGS='["0x...","0x...",40245]' node deploy/deploy-contract.mjs ../contracts/SynarchAgents.py
//   GL_DRY=1 node deploy/deploy-contract.mjs        # print the signer address only

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

const account = createAccount(privateKey());
console.log("Signer:", account.address);
if (process.env.GL_DRY) process.exit(0);

const file = process.argv[2];
if (!file) {
  console.error("Usage: node deploy/deploy-contract.mjs <path/to/contract.py>");
  process.exit(1);
}

const client = createClient({ chain: studioDevnet, endpoint: RPC, account });

const fees = await client.estimateTransactionFees({
  leaderTimeunitsAllocation: 100,
  validatorTimeunitsAllocation: 200,
  appealRounds: 0,
  executionBudgetPerRound: 25000000000000000n,
  totalMessageFees: 0,
  rotations: [3],
});

const args = process.env.GL_ARGS ? JSON.parse(process.env.GL_ARGS) : [];
const tx = await client.deployContract({
  code: new Uint8Array(readFileSync(file)),
  args,
  fees: { distribution: fees.distribution, feeValue: fees.feeValue },
});
console.log("Transaction:", tx);

const receipt = await client.waitForTransactionReceipt({
  hash: tx,
  waitUntil: "finalized",
  interval: 3000,
  retries: 300,
});
console.log("Execution:", receipt.tx_execution_result_name ?? receipt.status);
console.log("Address:", receipt.txDataDecoded?.contractAddress ?? "(not in receipt)");
