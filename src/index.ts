/**
 * Bridge Service - Entry Point
 *
 * Bidirectional relay between GenLayer and EVM chains via zkSync hub.
 */

import cron from "node-cron";
import {
  getBridgeSyncInterval,
  getEvmToGlSyncInterval,
  isEvmToGlBridgingEnabled,
} from "./config.js";
import { GenLayerToEvmRelay } from "./relay/GenLayerToEvm.js";
import { EvmToGenLayerRelay } from "./relay/EvmToGenLayer.js";

// `--once` runs a single relay pass and exits, for scheduled runners
// (GitHub Actions cron / cron-job.org). No `--once`: long-running mode with an
// internal cron loop, for a persistent host.
const onceMode = process.argv.includes("--once");

async function main() {
  if (onceMode) {
    console.log("Bridge Service: single relay pass (--once)");

    const glToEvm = new GenLayerToEvmRelay();
    await glToEvm.sync();

    if (isEvmToGlBridgingEnabled()) {
      const evmToGl = new EvmToGenLayerRelay();
      await evmToGl.sync();
    } else {
      console.log("  EVM → GenLayer: DISABLED (missing config)");
    }

    console.log("Single pass complete");
    return;
  }

  console.log("Starting Bridge Service");

  // GenLayer -> EVM relay
  const glToEvm = new GenLayerToEvmRelay();
  const glToEvmInterval = getBridgeSyncInterval();

  console.log(`  GenLayer → EVM: ${glToEvmInterval}`);
  glToEvm.sync(); // Initial sync
  cron.schedule(glToEvmInterval, () => glToEvm.sync());

  // EVM -> GenLayer relay (if configured)
  if (isEvmToGlBridgingEnabled()) {
    const evmToGl = new EvmToGenLayerRelay();
    const evmToGlInterval = getEvmToGlSyncInterval();

    console.log(`  EVM → GenLayer: ${evmToGlInterval}`);
    evmToGl.sync(); // Initial sync
    cron.schedule(evmToGlInterval, () => evmToGl.sync());
  } else {
    console.log("  EVM → GenLayer: DISABLED (missing config)");
  }

  console.log("Bridge service running");
}

main()
  .then(() => {
    // In --once mode nothing keeps the event loop alive, but open RPC sockets
    // can delay a natural exit, force it so the CI job finishes promptly.
    if (onceMode) process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT. Shutting down...");
  process.exit(0);
});
