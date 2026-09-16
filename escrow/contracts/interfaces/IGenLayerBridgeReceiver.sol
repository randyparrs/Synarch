// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IGenLayerBridgeReceiver
 * @notice Interface for contracts that receive and process bridged messages from
 *         GenLayer. Synarch keeps its own copy so contracts/synarch/ is
 *         self-contained and can move to the Synarch repo without pulling any
 *         AutoProof files (it is the standard GenLayer<->EVM bridge interface).
 */
interface IGenLayerBridgeReceiver {
    /**
     * @notice Process a bridged message from GenLayer.
     * @param _sourceChainId The chain ID of the source chain.
     * @param _sourceContract The address of the source contract on GenLayer.
     * @param _message The encoded message data to process.
     */
    function processBridgeMessage(
        uint32 _sourceChainId,
        address _sourceContract,
        bytes calldata _message
    ) external;
}
