/**
 * GenLayer -> EVM Relay
 *
 * Polls GenLayer BridgeSender for pending messages and relays them
 * via zkSync BridgeForwarder to destination EVM chains.
 */

import { ethers } from "ethers";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import type { Address } from "genlayer-js/types";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import {
  getBridgeForwarderAddress,
  getBridgeSenderAddress,
  getForwarderNetworkRpcUrl,
  getGenlayerRpcUrl,
  getPrivateKey,
} from "../config.js";

interface BridgeMessage {
  targetChainId: number;
  targetContract: string;
  data: string;
}

const BRIDGE_FORWARDER_ABI = [
  "function callRemoteArbitrary(bytes32 txHash, uint32 dstEid, bytes data, bytes options) external payable",
  "function quoteCallRemoteArbitrary(uint32 dstEid, bytes data, bytes options) external view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function isHashUsed(bytes32 txHash) external view returns (bool)",
];

export class GenLayerToEvmRelay {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private bridgeForwarder: ethers.Contract;
  private genLayerClient: any;
  private usedHashes: Set<string>;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(getForwarderNetworkRpcUrl());
    this.wallet = new ethers.Wallet(getPrivateKey(), this.provider);

    this.bridgeForwarder = new ethers.Contract(
      getBridgeForwarderAddress(),
      BRIDGE_FORWARDER_ABI,
      this.wallet
    );

    // Initialize GenLayer client
    const privateKey = getPrivateKey();
    const account = createAccount(`0x${privateKey.replace(/^0x/, "")}`);
    // Synarch runs on a GenLayer Studio node, so the chain must be a Studio one
    // (isStudio: true) and its id must match the node: the Studio API routes by chain id
    // and answers a mismatched one with an HTML error page instead of JSON. studionet is
    // 61999, Studio Next is 61997, so the id is overridden and kept configurable.
    const genlayerChainId = Number(process.env.GENLAYER_CHAIN_ID || 61997);
    this.genLayerClient = createClient({
      chain: {
        ...studionet,
        id: genlayerChainId,
        rpcUrls: {
          default: { http: [getGenlayerRpcUrl()] },
        },
      },
      account,
    });

    this.usedHashes = new Set<string>();
  }

  private async getPendingMessages(): Promise<string[]> {
    // No try/catch swallow here: if this read fails we must NOT silently report
    // "0 messages" and let the run exit success. Let the error propagate so the
    // scheduled run fails loudly instead of showing a false green.
    const response = await this.genLayerClient.readContract({
      address: getBridgeSenderAddress() as Address,
      functionName: "get_message_hashes",
      args: [],
    });

    if (!Array.isArray(response)) {
      throw new Error(
        `Unexpected get_message_hashes response: ${JSON.stringify(response)}`
      );
    }

    return response.filter(
      (hash): hash is string => !this.usedHashes.has(hash)
    );
  }

  private async relayMessage(hash: string): Promise<void> {
    // No try/catch swallow here either: a failed send must throw so sync() can
    // record it and fail the run. sync() wraps this per-message so one bad
    // message does not stop the others.
    console.log(`[GL→EVM] Processing message ${hash}`);

    // Check if already relayed
    const isUsed = await this.bridgeForwarder.isHashUsed(`0x${hash}`);
    if (isUsed) {
      console.log(`[GL→EVM] Message ${hash} already relayed, skipping`);
      return;
    }

    // Get message from GenLayer
    const messageResponse: Record<string, any> =
      await this.genLayerClient.readContract({
        address: getBridgeSenderAddress() as Address,
        functionName: "get_message",
        args: [hash],
      });

    // Convert data to hex
    let messageData = messageResponse.data;
    if (messageData instanceof Uint8Array || Buffer.isBuffer(messageData)) {
      messageData = "0x" + Buffer.from(messageData).toString("hex");
    } else if (
      typeof messageData === "string" &&
      !messageData.startsWith("0x")
    ) {
      messageData = "0x" + messageData;
    }

    const message: BridgeMessage = {
      targetChainId: Number(messageResponse.target_chain_id),
      targetContract: messageResponse.target_contract,
      data: messageData,
    };

    console.log(
      `[GL→EVM] Relaying to chain ${message.targetChainId}/${message.targetContract}`
    );

    // Build LayerZero options
    const optionsHex = Options.newOptions()
      .addExecutorLzReceiveOption(1_000_000, 0)
      .toHex();

    // Get fee quote
    const dstEid = message.targetChainId; // Already LZ EID
    const [nativeFee] = await this.bridgeForwarder.quoteCallRemoteArbitrary(
      dstEid,
      message.data,
      optionsHex
    );

    console.log(`[GL→EVM] Fee: ${ethers.formatEther(nativeFee)} ETH`);

    // Send via LayerZero
    const tx = await this.bridgeForwarder.callRemoteArbitrary(
      `0x${hash}`,
      dstEid,
      message.data,
      optionsHex,
      { value: nativeFee }
    );

    console.log(`[GL→EVM] TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[GL→EVM] Confirmed in block ${receipt.blockNumber}`);
  }

  public async sync(): Promise<void> {
    console.log("[GL→EVM] Starting sync...");

    const hashes = await this.getPendingMessages();
    console.log(`[GL→EVM] Found ${hashes.length} messages`);

    // Relay every message, but remember failures so the whole run can fail.
    // The per-message catch lets the other messages still get their chance; the
    // throw at the end makes a scheduled run exit non-zero (red) instead of a
    // false "success" when something actually broke.
    const failures: string[] = [];
    for (const hash of hashes) {
      this.usedHashes.add(hash);
      try {
        await this.relayMessage(hash);
      } catch (error) {
        console.error(`[GL→EVM] Error relaying ${hash}:`, error);
        failures.push(hash);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `[GL→EVM] ${failures.length} of ${hashes.length} message(s) failed to relay: ${failures.join(
          ", "
        )}`
      );
    }

    console.log("[GL→EVM] Sync complete");
  }
}
