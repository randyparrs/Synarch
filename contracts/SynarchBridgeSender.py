# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

"""SynarchBridgeSender: sends messages from GenLayer to EVM chains via the Synarch
bridge relay. Byte-identical fork of the proven AutoProof BridgeSender, redeployed
under Synarch so the economy shares no infrastructure with AutoProof."""

from dataclasses import dataclass
from typing import Any

import genlayer as gl
from genlayer.storage import allow as allow_storage


@allow_storage
@dataclass
class MessageData:
    target_chain_id: gl.u256
    target_contract: str
    data: bytes


class BridgeSender(gl.contract.Contract):
    messages: gl.storage.TreeMap[str, MessageData]
    nonce: gl.u256

    def __init__(self):
        self.nonce = gl.u256(0)

    @gl.public.write
    def send_message(self, target_chain_id: int, target_contract: str, data: bytes) -> str:
        """Send a message to be bridged. Returns message hash for tracking."""
        # Deterministic uniqueness (every validator computes the same hash): a
        # per-contract nonce replaces the old non-deterministic datetime.now().
        self.nonce = gl.u256(int(self.nonce) + 1)

        hasher = gl.Keccak256()
        hasher.update(int(self.nonce).to_bytes(32, "big"))
        hasher.update(gl.message.sender_address.as_bytes)
        hasher.update(target_contract.encode())
        hasher.update(data)

        message_hash = hasher.digest().hex()

        abi = (gl.u32, gl.Address, gl.Address, bytes)
        encoder = gl.evm.MethodEncoder("", abi, bool)
        message_data = (61998, gl.message.sender_address, gl.Address(str(target_contract)), data)
        message_bytes = encoder.encode_call(message_data)[4:]  # Remove method selector

        self.messages[message_hash] = MessageData(target_chain_id, target_contract, message_bytes)
        return message_hash

    @gl.public.view
    def get_message(self, message_hash: str) -> dict[str, Any]:
        return self.messages[message_hash]

    @gl.public.view
    def get_messages(self) -> dict[str, dict[str, Any]]:
        return self.messages

    @gl.public.view
    def get_message_hashes(self) -> list[str]:
        return list(self.messages.keys())
