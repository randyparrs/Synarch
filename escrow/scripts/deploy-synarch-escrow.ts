/**
 * Deploy SynarchEscrow (Synarch Phase 2) to Base Sepolia.
 *
 * ALLOWED_SOURCE is the SynarchJudge v0.2.0 address on GenLayer: the escrow only
 * accepts verdicts bridged from that judge. It is set in the constructor (no
 * Timelock at deploy), same pattern as the AutoProof treasury.
 *
 * Usage (from smart-contracts):
 *   USDC_ADDRESS=<usdc> BRIDGE_RECEIVER_ADDRESS=<receiver> ALLOWED_SOURCE=<judge> \
 *   SAFE_ADDRESS=<safe> TIMELOCK_ADDRESS=<timelock> \
 *   npx hardhat run scripts/synarch/deploy-synarch-escrow.ts --network baseSepoliaTestnet
 */

import { ethers } from "hardhat";
import {
  getNetworkInfo,
  logNetworkHeader,
  saveDeploymentResult,
  verifyContract,
  getEnvVar,
  validateAddress,
} from "../utils";

async function main() {
  const networkInfo = await getNetworkInfo();
  logNetworkHeader("Deploying SynarchEscrow", networkInfo);

  const usdcAddress = getEnvVar("USDC_ADDRESS");
  const bridgeReceiverAddress = getEnvVar("BRIDGE_RECEIVER_ADDRESS");
  const allowedSource = getEnvVar("ALLOWED_SOURCE");
  const allowedRefundSource = getEnvVar("ALLOWED_REFUND_SOURCE");
  const safeAddress = getEnvVar("SAFE_ADDRESS");
  const timelockAddress = getEnvVar("TIMELOCK_ADDRESS");

  validateAddress(usdcAddress, "USDC_ADDRESS");
  validateAddress(bridgeReceiverAddress, "BRIDGE_RECEIVER_ADDRESS");
  validateAddress(allowedSource, "ALLOWED_SOURCE");
  validateAddress(allowedRefundSource, "ALLOWED_REFUND_SOURCE");
  validateAddress(safeAddress, "SAFE_ADDRESS");
  validateAddress(timelockAddress, "TIMELOCK_ADDRESS");

  console.log("\nConfiguration:");
  console.log("  USDC:", usdcAddress);
  console.log("  BridgeReceiver:", bridgeReceiverAddress);
  console.log("  Allowed source (SynarchJudge, verdicts):", allowedSource);
  console.log("  Allowed refund source (SynarchAgents, client refunds):", allowedRefundSource);
  console.log("  Safe:", safeAddress);
  console.log("  Timelock:", timelockAddress);

  const SynarchEscrow = await ethers.getContractFactory("SynarchEscrow");
  const contract = await SynarchEscrow.deploy(
    usdcAddress,
    bridgeReceiverAddress,
    allowedSource,
    allowedRefundSource,
    safeAddress,
    timelockAddress
  );

  const deployTx = contract.deploymentTransaction();
  if (!deployTx) throw new Error("Deployment transaction not found");

  console.log("\nDeploying... TX:", deployTx.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  await saveDeploymentResult({
    contract: "SynarchEscrow",
    network: networkInfo.networkName,
    chainId: Number(networkInfo.chainId),
    address,
    deploymentHash: deployTx.hash,
    params: {
      usdc: usdcAddress,
      bridgeReceiver: bridgeReceiverAddress,
      allowedSource,
      allowedRefundSource,
      safe: safeAddress,
      timelock: timelockAddress,
    },
    timestamp: new Date().toISOString(),
  });

  await verifyContract(address, [
    usdcAddress,
    bridgeReceiverAddress,
    allowedSource,
    allowedRefundSource,
    safeAddress,
    timelockAddress,
  ]);

  console.log("\nSynarchEscrow deployed to:", address);
}

main().catch((error) => {
  console.error("\nDeployment failed!");
  console.error(error);
  process.exitCode = 1;
});
