import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { SynarchEscrow, MockERC20 } from "../../typechain-types";

describe("SynarchEscrow (Phase 2: escrow + verdict-driven payout)", function () {
  let escrow: SynarchEscrow;
  let usdc: MockERC20;
  let bridgeReceiver: SignerWithAddress;
  let allowedSource: SignerWithAddress; // stands in for the SynarchJudge (verdicts)
  let refundSource: SignerWithAddress; // stands in for the SynarchAgents (client refunds)
  let safe: SignerWithAddress;
  let timelock: SignerWithAddress;
  let client: SignerWithAddress;
  let researcher: SignerWithAddress;
  let dataAgent: SignerWithAddress;
  let stranger: SignerWithAddress;
  let a1: SignerWithAddress;
  let a2: SignerWithAddress;
  let a3: SignerWithAddress;
  let a4: SignerWithAddress;

  const SRC_CHAIN = 40245;
  const AG = "job-1";
  const TEN = 10_000_000n; // 10 USDC (6 decimals)
  const THREE = 3_000_000n; // 3 USDC
  const REFUND_CANCEL = 1n;
  const REFUND_TIMEOUT = 2n;

  function encodeVerdict(agreementId: string, verdict: string, culpables: string[]) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "address[]"],
      [agreementId, verdict, culpables],
    );
  }

  function encodeRefund(agreementId: string, action: bigint) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [agreementId, action]);
  }

  function refund(action: bigint, agreementId: string = AG) {
    return escrow
      .connect(bridgeReceiver)
      .processBridgeMessage(SRC_CHAIN, refundSource.address, encodeRefund(agreementId, action));
  }

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [, bridgeReceiver, allowedSource, refundSource, safe, timelock, client, researcher, dataAgent, stranger, a1, a2, a3, a4] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const Escrow = await ethers.getContractFactory("SynarchEscrow");
    escrow = await Escrow.deploy(
      await usdc.getAddress(),
      bridgeReceiver.address,
      allowedSource.address,
      refundSource.address,
      safe.address,
      timelock.address,
    );
    await escrow.waitForDeployment();

    // Mint each funder exactly what it deposits, so final balances equal payouts.
    await usdc.mint(client.address, TEN);
    await usdc.mint(researcher.address, THREE);
  });

  // The standard 2-link chain: Client funds 10 for the Researcher, the Researcher
  // funds 3 for the Data Agent.
  async function fundStandard() {
    const escrowAddr = await escrow.getAddress();
    await escrow.openAgreement(AG, client.address);
    await usdc.connect(client).approve(escrowAddr, TEN);
    await escrow.connect(client).deposit(AG, researcher.address, TEN);
    await usdc.connect(researcher).approve(escrowAddr, THREE);
    await escrow.connect(researcher).deposit(AG, dataAgent.address, THREE);
  }

  function settle(verdict: string, culpables: string[]) {
    return escrow
      .connect(bridgeReceiver)
      .processBridgeMessage(SRC_CHAIN, allowedSource.address, encodeVerdict(AG, verdict, culpables));
  }

  // --------------------------------------------------------------
  // (a) NO_FAULT: the work was done, every link is paid.
  // --------------------------------------------------------------
  it("NO_FAULT pays every beneficiary (Researcher 10, Data Agent 3)", async function () {
    await fundStandard();
    await settle("NO_FAULT", []);

    expect(await usdc.balanceOf(researcher.address)).to.equal(TEN);
    expect(await usdc.balanceOf(dataAgent.address)).to.equal(THREE);
    expect(await usdc.balanceOf(client.address)).to.equal(0n);
    expect(await escrow.balance()).to.equal(0n);

    const a = await escrow.getAgreement(AG);
    expect(a.settled).to.equal(true);
    expect(a.verdict).to.equal("NO_FAULT");
  });

  // --------------------------------------------------------------
  // (b) DATA_AGENT at fault: Data Agent not paid, Client recovers.
  // --------------------------------------------------------------
  it("DATA_AGENT fault refunds the Client and returns the Data Agent's part", async function () {
    await fundStandard();
    await settle("DATA_AGENT", [dataAgent.address]);

    expect(await usdc.balanceOf(researcher.address)).to.equal(TEN); // honest, keeps its share
    expect(await usdc.balanceOf(client.address)).to.equal(THREE); // recovers only the culpable's share
    expect(await usdc.balanceOf(dataAgent.address)).to.equal(0n); // culpable, not paid
    expect(await escrow.balance()).to.equal(0n);

    const a = await escrow.getAgreement(AG);
    expect([...a.culpableAgents]).to.deep.equal([dataAgent.address]);
  });

  // --------------------------------------------------------------
  // (c) RESEARCHER at fault: Data Agent paid, Researcher not, Client recovers.
  // --------------------------------------------------------------
  it("RESEARCHER fault pays the Data Agent, not the Researcher, and refunds the Client", async function () {
    await fundStandard();
    await settle("RESEARCHER", [researcher.address]);

    expect(await usdc.balanceOf(client.address)).to.equal(TEN); // client recovers
    expect(await usdc.balanceOf(dataAgent.address)).to.equal(THREE); // fulfilled, paid
    expect(await usdc.balanceOf(researcher.address)).to.equal(0n); // funded 3, got nothing
    expect(await escrow.balance()).to.equal(0n);
  });

  // --------------------------------------------------------------
  // (d) MULTIPLE culprits: every culpable beneficiary refunds to the Client.
  // --------------------------------------------------------------
  it("multiple culprits: both shares to the Client, event emits the full list", async function () {
    await fundStandard();
    await expect(settle("RESEARCHER, DATA_AGENT", [researcher.address, dataAgent.address]))
      .to.emit(escrow, "AgreementSettled");

    expect(await usdc.balanceOf(client.address)).to.equal(TEN + THREE); // both shares recovered
    expect(await usdc.balanceOf(researcher.address)).to.equal(0n);      // culpable, not paid
    expect(await usdc.balanceOf(dataAgent.address)).to.equal(0n);       // culpable, not paid
    expect(await escrow.balance()).to.equal(0n);

    const a = await escrow.getAgreement(AG);
    expect([...a.culpableAgents]).to.deep.equal([researcher.address, dataAgent.address]);
  });

  // --------------------------------------------------------------
  // Agent-count agnostic: a 3-link chain settles correctly with no redeploy.
  // Chain: a1(client)->a2 : 5, a2->a3 : 2, a3->a4 : 1. Fault at a3 exercises all
  // three payout branches at once (client recovers, culpable refunds, fulfiller paid).
  // --------------------------------------------------------------
  it("is agent-count agnostic: a 3-link chain settles correctly (fault at the middle)", async function () {
    const escrowAddr = await escrow.getAddress();
    const FIVE = 5_000_000n;
    const TWO = 2_000_000n;
    const ONE = 1_000_000n;
    await usdc.mint(a1.address, FIVE);
    await usdc.mint(a2.address, TWO);
    await usdc.mint(a3.address, ONE);

    await escrow.openAgreement("job-3link", a1.address);
    await usdc.connect(a1).approve(escrowAddr, FIVE);
    await escrow.connect(a1).deposit("job-3link", a2.address, FIVE);
    await usdc.connect(a2).approve(escrowAddr, TWO);
    await escrow.connect(a2).deposit("job-3link", a3.address, TWO);
    await usdc.connect(a3).approve(escrowAddr, ONE);
    await escrow.connect(a3).deposit("job-3link", a4.address, ONE);

    await escrow
      .connect(bridgeReceiver)
      .processBridgeMessage(
        SRC_CHAIN,
        allowedSource.address,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "address[]"],
          ["job-3link", "MIDDLE_FAULT", [a3.address]],
        ),
      );

    expect(await usdc.balanceOf(a2.address)).to.equal(FIVE); // honest, keeps its share
    expect(await usdc.balanceOf(a1.address)).to.equal(TWO); // client gets the culpable's (a3) share
    expect(await usdc.balanceOf(a3.address)).to.equal(0n); // culpable, not paid
    expect(await usdc.balanceOf(a4.address)).to.equal(ONE); // honest, keeps its share
    expect(await escrow.balance()).to.equal(0n);

    const a = await escrow.getAgreement("job-3link");
    expect(a.depositCount).to.equal(3n);
  });

  // --------------------------------------------------------------
  // Security.
  // --------------------------------------------------------------
  describe("security", function () {
    it("replay protection: a second verdict for the same agreement reverts", async function () {
      await fundStandard();
      await settle("NO_FAULT", []);
      await expect(settle("DATA_AGENT", [dataAgent.address])).to.be.revertedWithCustomError(
        escrow,
        "AlreadySettled",
      );
    });

    it("rejects a verdict from an untrusted source contract", async function () {
      await fundStandard();
      await expect(
        escrow
          .connect(bridgeReceiver)
          .processBridgeMessage(SRC_CHAIN, stranger.address, encodeVerdict(AG, "NO_FAULT", [])),
      ).to.be.revertedWithCustomError(escrow, "UntrustedSource");
    });

    it("rejects a verdict from anyone other than the bridge receiver", async function () {
      await fundStandard();
      await expect(
        escrow
          .connect(stranger)
          .processBridgeMessage(SRC_CHAIN, allowedSource.address, encodeVerdict(AG, "NO_FAULT", [])),
      ).to.be.revertedWithCustomError(escrow, "OnlyBridgeReceiver");
    });

    it("setAllowedSource is timelock-only", async function () {
      await expect(escrow.connect(stranger).setAllowedSource(stranger.address)).to.be.revertedWithCustomError(
        escrow,
        "OnlyTimelock",
      );
      await escrow.connect(timelock).setAllowedSource(stranger.address);
      expect(await escrow.allowedSource()).to.equal(stranger.address);
    });

    it("pause is Safe-only and blocks deposits", async function () {
      await escrow.openAgreement(AG, client.address);
      await expect(escrow.connect(stranger).pause()).to.be.revertedWithCustomError(escrow, "OnlySafe");
      await escrow.connect(safe).pause();
      await usdc.connect(client).approve(await escrow.getAddress(), TEN);
      await expect(escrow.connect(client).deposit(AG, researcher.address, TEN)).to.be.revertedWithCustomError(
        escrow,
        "EnforcedPause",
      );
    });

    it("cannot deposit into an already-settled agreement", async function () {
      await fundStandard();
      await settle("NO_FAULT", []);
      await usdc.mint(client.address, TEN);
      await usdc.connect(client).approve(await escrow.getAddress(), TEN);
      await expect(escrow.connect(client).deposit(AG, researcher.address, TEN)).to.be.revertedWithCustomError(
        escrow,
        "AlreadySettled",
      );
    });

    it("rejects a duplicate agreement id", async function () {
      await escrow.openAgreement(AG, client.address);
      await expect(escrow.openAgreement(AG, client.address)).to.be.revertedWithCustomError(
        escrow,
        "AgreementExists",
      );
    });
  });

  // --------------------------------------------------------------
  // Client refund (rule A + B). Funds return to the recorded DEPOSITORS (double
  // lock), never to any address from the message. CANCEL is immediate; TIMEOUT is
  // honored only after refundTimeout elapsed on this contract's clock.
  // --------------------------------------------------------------
  describe("client refund (rule A + B)", function () {
    it("CANCEL refunds every depositor and never a message address", async function () {
      await fundStandard();
      await refund(REFUND_CANCEL);

      // Double lock: each depositor gets its own deposit back (client 10, researcher 3),
      // NOT the beneficiaries.
      expect(await usdc.balanceOf(client.address)).to.equal(TEN);
      expect(await usdc.balanceOf(researcher.address)).to.equal(THREE);
      expect(await usdc.balanceOf(dataAgent.address)).to.equal(0n);
      expect(await escrow.balance()).to.equal(0n);

      const a = await escrow.getAgreement(AG);
      expect(a.settled).to.equal(true);
      expect(a.verdict).to.equal("REFUNDED");
    });

    it("TIMEOUT reverts before the timeout and succeeds after it elapses", async function () {
      await fundStandard();
      // refundTimeout defaults to 1 hour; not elapsed yet.
      await expect(refund(REFUND_TIMEOUT)).to.be.revertedWithCustomError(escrow, "TimeoutNotElapsed");

      await increaseTime(3601); // > 1 hour
      await refund(REFUND_TIMEOUT);

      expect(await usdc.balanceOf(client.address)).to.equal(TEN);
      expect(await usdc.balanceOf(researcher.address)).to.equal(THREE);
      expect(await escrow.balance()).to.equal(0n);
      expect((await escrow.getAgreement(AG)).settled).to.equal(true);
    });

    it("a completed chain that already settled by verdict cannot be refunded", async function () {
      await fundStandard();
      await settle("NO_FAULT", []);
      await expect(refund(REFUND_CANCEL)).to.be.revertedWithCustomError(escrow, "AlreadySettled");
    });

    it("after a refund, a later verdict for the same agreement reverts (one-shot)", async function () {
      await fundStandard();
      await refund(REFUND_CANCEL);
      await expect(settle("DATA_AGENT", [dataAgent.address])).to.be.revertedWithCustomError(
        escrow,
        "AlreadySettled",
      );
    });

    it("rejects an unknown refund action", async function () {
      await fundStandard();
      await expect(refund(99n)).to.be.revertedWithCustomError(escrow, "InvalidAction");
    });

    it("rejects a refund from an untrusted source", async function () {
      await fundStandard();
      await expect(
        escrow
          .connect(bridgeReceiver)
          .processBridgeMessage(SRC_CHAIN, stranger.address, encodeRefund(AG, REFUND_CANCEL)),
      ).to.be.revertedWithCustomError(escrow, "UntrustedSource");
    });

    it("rejects a refund for an unknown agreement", async function () {
      await expect(refund(REFUND_CANCEL, "ghost")).to.be.revertedWithCustomError(escrow, "AgreementNotFound");
    });

    it("setAllowedRefundSource and setRefundTimeout are timelock-only", async function () {
      await expect(
        escrow.connect(stranger).setAllowedRefundSource(stranger.address),
      ).to.be.revertedWithCustomError(escrow, "OnlyTimelock");
      await expect(escrow.connect(stranger).setRefundTimeout(60)).to.be.revertedWithCustomError(
        escrow,
        "OnlyTimelock",
      );

      await escrow.connect(timelock).setAllowedRefundSource(stranger.address);
      expect(await escrow.allowedRefundSource()).to.equal(stranger.address);
      await escrow.connect(timelock).setRefundTimeout(60);
      expect(await escrow.refundTimeout()).to.equal(60n);
    });

    it("the judge verdict path still works unchanged with the second source configured", async function () {
      await fundStandard();
      await settle("DATA_AGENT", [dataAgent.address]);
      expect(await usdc.balanceOf(client.address)).to.equal(THREE); // recovers only the culpable's share
      expect(await usdc.balanceOf(dataAgent.address)).to.equal(0n); // culpable not paid
      expect((await escrow.getAgreement(AG)).verdict).to.equal("DATA_AGENT");
    });
  });
});
