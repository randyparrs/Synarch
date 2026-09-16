// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IGenLayerBridgeReceiver} from "./interfaces/IGenLayerBridgeReceiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SynarchEscrow
 * @notice Phase 2 of Synarch: holds testnet USDC for an agreement between a chain
 *         of AI agents, and releases it according to the dispute verdict emitted
 *         by the SynarchJudge on GenLayer, relayed through the same LayerZero
 *         bridge AutoProof uses. Only the trusted BridgeReceiver may call
 *         processBridgeMessage(), and only messages originating from the
 *         configured SynarchJudge source contract are accepted.
 *
 * Agent-count agnostic: an agreement is a dynamic list of deposits, each one
 * {depositor, beneficiary, amount}. It works with 2, 3, 6 or any number of links
 * with no redeploy, because nothing hardcodes a fixed set of agents. The only
 * special role is the "client": the protected party who recovers on any fault.
 *
 * Payout logic (v1) lives isolated in _resolveDeposit so a future "layered
 * justice" version (each link paid by its real responsibility along the
 * dependency chain) can replace it without touching storage or the bridge path.
 *
 * Client refund (rule A + B): a client's USDC is never stranded if a chain does not
 * complete. The SynarchAgents contract (allowedRefundSource) authorizes the refund on
 * GenLayer (where the chain state lives) and dispatches it here through the same bridge,
 * with a CANCEL action (chain was intact) or a TIMEOUT action (chain stalled, honored
 * only after refundTimeout elapsed on this contract's clock). A refund returns funds to
 * each recorded DEPOSITOR, never to any address carried in the message (double lock), and
 * sets the same one-shot settled flag, so a completed chain can only be settled by a
 * verdict, never refunded.
 *
 * Governance (same model as AutoProof's treasury, no single-owner discretion over funds):
 * usdc / bridgeReceiver / allowedSource / allowedRefundSource / refundTimeout change only
 * through the Safe-proposed, timelock-delayed TimelockController; pause()/unpause() is the
 * Safe directly (defensive, never moves funds). There is NO owner withdraw/rescue of any
 * kind: funds leave only through processBridgeMessage()'s verdict- or refund-driven path.
 */
contract SynarchEscrow is IGenLayerBridgeReceiver, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    address public bridgeReceiver;
    address public allowedSource; // the SynarchJudge contract on GenLayer (verdicts)
    address public allowedRefundSource; // the SynarchAgents contract on GenLayer (client refunds)

    address public immutable safe;
    address public immutable timelock;

    // Client refund (rule A + B). A refund message from allowedRefundSource carries an
    // action: CANCEL (chain intact, authorized on GenLayer, immediate) or TIMEOUT (chain
    // stalled; honored only after refundTimeout has elapsed on this chain's clock).
    uint256 private constant ACTION_REFUND_CANCEL = 1;
    uint256 private constant ACTION_REFUND_TIMEOUT = 2;
    uint256 public refundTimeout; // seconds a stalled chain must age before a timeout refund
    mapping(string => uint256) public fundedAt; // first-deposit timestamp, per agreement

    struct Deposit {
        address depositor;
        address beneficiary;
        uint256 amount;
    }

    struct Agreement {
        bool exists;
        bool settled; // replay protection: a verdict settles an agreement once
        address client; // the protected party, recovers on any fault
        string verdict; // recorded from the judge for the record/frontend
        address[] culpableAgents; // the at-fault agents (empty = NO_FAULT)
        uint256 total; // total USDC held for this agreement
        Deposit[] deposits;
    }

    mapping(string => Agreement) private agreements;
    string[] private agreementIds;

    event AgreementOpened(string indexed agreementId, address indexed client);
    event Deposited(string indexed agreementId, address indexed depositor, address indexed beneficiary, uint256 amount);
    event AgreementSettled(string indexed agreementId, string verdict, address[] culpableAgents, uint256 total);
    event AgreementRefunded(string indexed agreementId, uint256 action, uint256 total);
    event Payout(string indexed agreementId, address indexed to, uint256 amount);
    event BridgeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
    event AllowedSourceUpdated(address indexed oldSource, address indexed newSource);
    event AllowedRefundSourceUpdated(address indexed oldSource, address indexed newSource);
    event RefundTimeoutUpdated(uint256 oldTimeout, uint256 newTimeout);
    event UsdcTokenUpdated(address indexed oldToken, address indexed newToken);

    error OnlyBridgeReceiver();
    error OnlyTimelock();
    error OnlySafe();
    error ZeroAddress();
    error AmountZero();
    error UntrustedSource();
    error AgreementExists();
    error AgreementNotFound();
    error AlreadySettled();
    error InvalidAction();
    error TimeoutNotElapsed();

    modifier onlyBridgeReceiver() {
        if (msg.sender != bridgeReceiver) revert OnlyBridgeReceiver();
        _;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    constructor(
        address _usdc,
        address _bridgeReceiver,
        address _allowedSource,
        address _allowedRefundSource,
        address _safe,
        address _timelock
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_bridgeReceiver == address(0)) revert ZeroAddress();
        if (_allowedSource == address(0)) revert ZeroAddress();
        if (_allowedRefundSource == address(0)) revert ZeroAddress();
        if (_safe == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        bridgeReceiver = _bridgeReceiver;
        allowedSource = _allowedSource;
        allowedRefundSource = _allowedRefundSource;
        safe = _safe;
        timelock = _timelock;
        refundTimeout = 1 hours; // demo default; tunable by timelock
    }

    // ------------------------------------------------------------------
    // Forming and funding an agreement (open to any wallet)
    // ------------------------------------------------------------------

    /// @notice Declare an agreement and its protected client. The agreementId
    ///         must match the SynarchJudge dispute_id so the verdict finds it.
    function openAgreement(string calldata agreementId, address client) external whenNotPaused {
        if (client == address(0)) revert ZeroAddress();
        Agreement storage a = agreements[agreementId];
        if (a.exists) revert AgreementExists();
        a.exists = true;
        a.client = client;
        agreementIds.push(agreementId);
        emit AgreementOpened(agreementId, client);
    }

    /// @notice Deposit USDC earmarked to a beneficiary for this agreement. Any
    ///         party can deposit for any beneficiary; there is no fixed agent
    ///         list, which is what makes the escrow agent-count agnostic.
    function deposit(string calldata agreementId, address beneficiary, uint256 amount)
        external
        whenNotPaused
        nonReentrant
    {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();
        Agreement storage a = agreements[agreementId];
        if (!a.exists) revert AgreementNotFound();
        if (a.settled) revert AlreadySettled();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        a.deposits.push(Deposit({depositor: msg.sender, beneficiary: beneficiary, amount: amount}));
        a.total += amount;
        // Start the refund-timeout clock at the first deposit (rule B is measured here,
        // on Base's reliable clock).
        if (fundedAt[agreementId] == 0) fundedAt[agreementId] = block.timestamp;
        emit Deposited(agreementId, msg.sender, beneficiary, amount);
    }

    // ------------------------------------------------------------------
    // Verdict-driven settlement (only via the trusted bridge)
    // ------------------------------------------------------------------

    function processBridgeMessage(
        uint32 /* _sourceChainId */,
        address _sourceContract,
        bytes calldata _message
    ) external onlyBridgeReceiver whenNotPaused nonReentrant {
        // Branch by the trusted GenLayer source: the judge settles by verdict; the
        // agents contract triggers a client refund. Each carries its own message shape.
        if (_sourceContract == allowedSource) {
            _settleVerdict(_message);
        } else if (_sourceContract == allowedRefundSource) {
            _refund(_message);
        } else {
            revert UntrustedSource();
        }
    }

    function _settleVerdict(bytes calldata _message) private {
        (string memory agreementId, string memory verdict, address[] memory culpableAgents) =
            abi.decode(_message, (string, string, address[]));

        Agreement storage a = agreements[agreementId];
        if (!a.exists) revert AgreementNotFound();
        if (a.settled) revert AlreadySettled(); // replay protection

        a.settled = true;
        a.verdict = verdict;
        a.culpableAgents = culpableAgents;

        uint256 len = a.deposits.length;
        for (uint256 i = 0; i < len; i++) {
            Deposit storage d = a.deposits[i];
            address payTo = _resolveDeposit(d, culpableAgents, a.client);
            usdc.safeTransfer(payTo, d.amount);
            emit Payout(agreementId, payTo, d.amount);
        }

        emit AgreementSettled(agreementId, verdict, culpableAgents, a.total);
    }

    /**
     * @notice Client refund (rule A + B). The message carries only (agreementId, action);
     *         the client was authenticated on GenLayer before this was dispatched. The
     *         double lock: funds return to each recorded DEPOSITOR, never to any address
     *         from the message. CANCEL is immediate (GenLayer proved the chain was intact);
     *         TIMEOUT is honored only after refundTimeout has elapsed on this contract's
     *         clock, so a completed chain can never be refunded, only settled by a verdict.
     */
    function _refund(bytes calldata _message) private {
        (string memory agreementId, uint256 action) = abi.decode(_message, (string, uint256));

        Agreement storage a = agreements[agreementId];
        if (!a.exists) revert AgreementNotFound();
        if (a.settled) revert AlreadySettled(); // replay protection (same one-shot flag)

        if (action == ACTION_REFUND_TIMEOUT) {
            if (block.timestamp < fundedAt[agreementId] + refundTimeout) revert TimeoutNotElapsed();
        } else if (action != ACTION_REFUND_CANCEL) {
            revert InvalidAction();
        }

        a.settled = true;
        a.verdict = "REFUNDED";

        uint256 len = a.deposits.length;
        for (uint256 i = 0; i < len; i++) {
            Deposit storage d = a.deposits[i];
            usdc.safeTransfer(d.depositor, d.amount); // double lock: back to the depositor
            emit Payout(agreementId, d.depositor, d.amount);
        }

        emit AgreementRefunded(agreementId, action, a.total);
    }

    /**
     * @notice v1 payout rule for a single deposit. ISOLATED on purpose: a future
     *         "layered justice" version replaces only this function.
     *
     * - NO_FAULT (culpableAgents is empty): every beneficiary is paid.
     * - On a fault:
     *     - a culpable agent's deposit refunds to the client (the task creator);
     *     - every other (honest) beneficiary keeps its own share.
     *
     * Payout is decided by beneficiary-vs-culpables, never by depositor, so a client
     * that funds every agent's share still pays the honest agents on a fault and only
     * reclaims the culpable shares.
     */
    function _resolveDeposit(Deposit storage d, address[] memory culpableAgents, address client)
        internal
        view
        returns (address)
    {
        if (culpableAgents.length == 0) {
            return d.beneficiary; // NO_FAULT: every beneficiary is paid
        }
        // Membership replaces the old single-address equality: is this deposit's
        // beneficiary one of the at-fault agents? This loop is nested inside the
        // per-deposit loop in _settleVerdict, so settlement is O(deposits * culprits).
        // GAS: trivial at Synarch's chain length (5-6 agents) — at most ~36 comparisons
        // for a whole settlement, negligible. Revisit only if chains grow orders larger.
        for (uint256 j = 0; j < culpableAgents.length; j++) {
            if (d.beneficiary == culpableAgents[j]) {
                return client; // the at-fault agent's share refunds to the client
            }
        }
        return d.beneficiary; // an honest agent keeps its own share
    }

    // ------------------------------------------------------------------
    // Admin (Safe + Timelock, same model as AutoProof; no fund withdrawal)
    // ------------------------------------------------------------------

    function setBridgeReceiver(address _newBridgeReceiver) external onlyTimelock {
        if (_newBridgeReceiver == address(0)) revert ZeroAddress();
        address old = bridgeReceiver;
        bridgeReceiver = _newBridgeReceiver;
        emit BridgeReceiverUpdated(old, _newBridgeReceiver);
    }

    function setAllowedSource(address _newAllowedSource) external onlyTimelock {
        if (_newAllowedSource == address(0)) revert ZeroAddress();
        address old = allowedSource;
        allowedSource = _newAllowedSource;
        emit AllowedSourceUpdated(old, _newAllowedSource);
    }

    function setAllowedRefundSource(address _newRefundSource) external onlyTimelock {
        if (_newRefundSource == address(0)) revert ZeroAddress();
        address old = allowedRefundSource;
        allowedRefundSource = _newRefundSource;
        emit AllowedRefundSourceUpdated(old, _newRefundSource);
    }

    function setRefundTimeout(uint256 _newTimeout) external onlyTimelock {
        uint256 old = refundTimeout;
        refundTimeout = _newTimeout;
        emit RefundTimeoutUpdated(old, _newTimeout);
    }

    function setUsdcToken(address _newUsdc) external onlyTimelock {
        if (_newUsdc == address(0)) revert ZeroAddress();
        address old = address(usdc);
        usdc = IERC20(_newUsdc);
        emit UsdcTokenUpdated(old, _newUsdc);
    }

    function pause() external onlySafe {
        _pause();
    }

    function unpause() external onlySafe {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Views (for a future frontend)
    // ------------------------------------------------------------------

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function getAgreement(string calldata agreementId)
        external
        view
        returns (
            bool exists,
            bool settled,
            address client,
            string memory verdict,
            address[] memory culpableAgents,
            uint256 total,
            uint256 depositCount
        )
    {
        Agreement storage a = agreements[agreementId];
        return (a.exists, a.settled, a.client, a.verdict, a.culpableAgents, a.total, a.deposits.length);
    }

    function getDeposit(string calldata agreementId, uint256 index)
        external
        view
        returns (address depositor, address beneficiary, uint256 amount)
    {
        Deposit storage d = agreements[agreementId].deposits[index];
        return (d.depositor, d.beneficiary, d.amount);
    }

    function getAgreementIds() external view returns (string[] memory) {
        return agreementIds;
    }
}
