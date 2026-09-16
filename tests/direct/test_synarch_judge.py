import json
import os

# Absolute path so the contract is found regardless of the pytest working dir.
CONTRACT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "contracts", "SynarchJudge.py")
)

DATA_AGENT = "0x1111111111111111111111111111111111111111"
ANALYST = "0x3333333333333333333333333333333333333333"
RESEARCHER = "0x2222222222222222222222222222222222222222"

# Bridge config (dummy values for direct-mode; the real emit is exercised live).
# Same BridgeSender that AutoProof uses.
BRIDGE_SENDER = "0xBe5D5066e25D87D46A0D881d698eD3d0316479Ae"
ESCROW = "0x000000000000000000000000000000000000dEaD"
TARGET_EID = 40245

AGREEMENT = "Determine whether Apple had more revenue than Microsoft in the last reported fiscal quarter."
DATA = "Apple = 120B in revenue, Microsoft = 62B in revenue."
CONCLUSION = "Apple had more revenue, recommend Apple."
FINAL = "Apple"
DISPUTE_REASON = "The client claims the recommendation is wrong."

# A 3-link delegation: Data Agent -> Analyst (processes) -> Researcher (concludes).
PROCESSED = "Delta computed: Apple leads Microsoft by 58B in the quarter."


def _deploy(direct_deploy, direct_vm, owner):
    direct_vm.sender = owner
    return direct_deploy(CONTRACT, BRIDGE_SENDER, ESCROW, TARGET_EID)


def _submit_2(contract, dispute_id="d1", evidence_url=""):
    """Phase 1 two-link chain via the preserved submit_dispute signature."""
    contract.submit_dispute(
        dispute_id, AGREEMENT, DATA, CONCLUSION, FINAL, DISPUTE_REASON,
        DATA_AGENT, RESEARCHER, evidence_url,
    )


def _submit_3(contract, dispute_id="c1", evidence_url=""):
    """Three-link delegation chain via the generic submit_chain_dispute."""
    contract.submit_chain_dispute(
        dispute_id,
        AGREEMENT,
        ["data_agent", "analyst", "researcher"],
        [DATA_AGENT, ANALYST, RESEARCHER],
        [DATA, PROCESSED, CONCLUSION],
        FINAL,
        DISPUTE_REASON,
        evidence_url,
    )


def _mock_steps(direct_vm, steps, reason="because"):
    """Mock the generic LLM response: a per-step boolean list + a free-form reason."""
    direct_vm.mock_llm(r"(?s).*", json.dumps({"steps": steps, "reason": reason}))


# ======================================================================
# (a) 2-link chain (Phase 1 compatibility): the three verdicts are identical.
# ======================================================================

def test_2link_no_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_2(contract)
    _mock_steps(direct_vm, [True, True], "Data matches reality and the conclusion follows.")
    r = contract.judge_dispute("d1")
    assert r["verdict"] == "NO_FAULT"
    assert r["culpable_agents"] == []
    assert r["culpable_indices"] == []
    assert r["status"] == "judged"
    assert contract.get_verdict("d1")["verdict"] == "NO_FAULT"


def test_2link_data_agent_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_2(contract)
    _mock_steps(direct_vm, [False, True], "The delivered revenue figures do not match reality.")
    r = contract.judge_dispute("d1")
    assert r["verdict"] == "DATA_AGENT"
    assert r["culpable_agents"] == [DATA_AGENT]
    assert r["culpable_indices"] == [0]
    assert contract.get_dispute("d1")["verdict"] == "DATA_AGENT"


def test_2link_researcher_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_2(contract)
    _mock_steps(direct_vm, [True, False], "The data was right but the conclusion picked the wrong company.")
    r = contract.judge_dispute("d1")
    assert r["verdict"] == "RESEARCHER"
    assert r["culpable_agents"] == [RESEARCHER]
    assert r["culpable_indices"] == [1]


# ======================================================================
# (b) 3-link chain, fault at the subcontracted Data Agent (first link).
# ======================================================================

def test_3link_data_agent_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [False, True, True], "The raw figures the data agent delivered are wrong.")
    r = contract.judge_dispute("c1")
    assert r["verdict"] == "DATA_AGENT"
    assert r["culpable_agents"] == [DATA_AGENT]
    assert r["culpable_indices"] == [0]


# ======================================================================
# (b') 3-link chain, fault at the Analyst (middle link) — the new case.
# Data was right, but the analyst processed it wrongly.
# ======================================================================

def test_3link_analyst_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, False, True], "The data was right but the analyst mis-processed it.")
    r = contract.judge_dispute("c1")
    assert r["verdict"] == "ANALYST"
    assert r["culpable_agents"] == [ANALYST]
    assert r["culpable_indices"] == [1]


# ======================================================================
# (c) 3-link chain, fault at the Researcher (last link).
# Everything upstream was right, the researcher concluded wrongly.
# ======================================================================

def test_3link_researcher_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, True, False], "Data and processing were right, the conclusion was wrong.")
    r = contract.judge_dispute("c1")
    assert r["verdict"] == "RESEARCHER"
    assert r["culpable_agents"] == [RESEARCHER]
    assert r["culpable_indices"] == [2]


# ======================================================================
# (d) 3-link chain, everything correct -> NO_FAULT.
# ======================================================================

def test_3link_no_fault(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, True, True], "Every step is consistent with reality.")
    r = contract.judge_dispute("c1")
    assert r["verdict"] == "NO_FAULT"
    assert r["culpable_agents"] == []
    assert r["culpable_indices"] == []


# ======================================================================
# Independent breaks: EACH failing step whose input was correct is blamed,
# but a step downstream of a break (fed corrupted data) stays a protected victim.
# ======================================================================

def test_independent_breaks_both_blamed(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    # Data wrong (first step, an independent break) AND researcher wrong while ITS input
    # (the analyst's correct output) was good -> a SECOND independent break. Both blamed;
    # the analyst in between was correct.
    _mock_steps(direct_vm, [False, True, False], "Two independent breaks: data agent and researcher.")
    r = contract.judge_dispute("c1")
    assert r["culpable_indices"] == [0, 2]
    assert r["culpable_agents"] == [DATA_AGENT, RESEARCHER]
    assert r["verdict"] == "DATA_AGENT, RESEARCHER"


def test_downstream_victim_protected(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    # Data wrong, then the analyst is wrong BECAUSE it was fed corrupted data (its input,
    # the data agent's output, was already bad). Only the upstream break is blamed; the
    # analyst stays a protected victim.
    _mock_steps(direct_vm, [False, False, True], "Bad raw data; the analyst is a downstream victim.")
    r = contract.judge_dispute("c1")
    assert r["culpable_indices"] == [0]
    assert r["culpable_agents"] == [DATA_AGENT]
    assert r["verdict"] == "DATA_AGENT"


# ======================================================================
# Consensus compares ONLY where the chain broke (the culpable position),
# never the reason text.
# ======================================================================

def test_consensus_agrees_on_same_break_ignores_reason(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)

    # Leader: analyst is the first break, worded one way.
    _mock_steps(direct_vm, [True, False, True], "leader wording: analyst mis-processed")
    contract.judge_dispute("c1")

    # Validator reaches the SAME first break (index 1) but words the why differently,
    # AND even disagrees on a downstream boolean (step 3). Must still AGREE.
    direct_vm.clear_mocks()
    _mock_steps(direct_vm, [True, False, False], "validator words it totally differently")
    assert direct_vm.run_validator() is True


def test_consensus_disagrees_on_different_break(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)

    _mock_steps(direct_vm, [True, False, True], "leader: analyst broke it")
    contract.judge_dispute("c1")

    # Validator sees the break at a DIFFERENT position (data agent) -> must DISAGREE.
    direct_vm.clear_mocks()
    _mock_steps(direct_vm, [False, True, True], "validator: data agent broke it")
    assert direct_vm.run_validator() is False


# ======================================================================
# Getters expose the generic chain and the reusable verdict.
# ======================================================================

def test_getters_expose_chain_and_reusable_verdict(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)

    d = contract.get_dispute("c1")
    assert d["status"] == "open"
    assert d["agreement"] == AGREEMENT
    links = d["links"]
    assert len(links) == 3
    assert links[0]["role"] == "data_agent" and links[0]["agent"] == DATA_AGENT
    assert links[1]["role"] == "analyst" and links[1]["agent"] == ANALYST
    assert links[2]["role"] == "researcher" and links[2]["delivered"] == CONCLUSION
    assert d["verdict"] == ""
    assert "c1" in contract.get_dispute_ids()

    _mock_steps(direct_vm, [True, False, True], "analyst mis-processed")
    contract.judge_dispute("c1")

    v = contract.get_verdict("c1")
    assert v["status"] == "judged"
    assert v["verdict"] == "ANALYST"
    assert v["culpable_agents"] == [ANALYST]  # reusable for reputation later


# ======================================================================
# When an evidence URL is present, the judge fetches the web to ground the fact.
# ======================================================================

def test_judge_with_evidence_url_fetches_web(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract, evidence_url="https://example.com/apple-msft-revenue")

    direct_vm.mock_web(
        r".*example\.com/apple-msft-revenue.*",
        {"status": 200, "body": "Apple last quarter revenue 120B, Microsoft last quarter revenue 62B."},
    )
    _mock_steps(direct_vm, [True, True, True], "Delivered data matches the fetched source and the chain follows.")
    r = contract.judge_dispute("c1")
    assert r["verdict"] == "NO_FAULT"


# ======================================================================
# Guardrails.
# ======================================================================

def test_duplicate_dispute_id_rejected(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_2(contract)
    with direct_vm.expect_revert("Dispute id already used"):
        _submit_2(contract)


def test_cannot_judge_twice(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_2(contract)
    _mock_steps(direct_vm, [True, True], "ok")
    contract.judge_dispute("d1")
    with direct_vm.expect_revert("already judged"):
        contract.judge_dispute("d1")


def test_chain_requires_at_least_two_links(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    with direct_vm.expect_revert("at least 2 links"):
        contract.submit_chain_dispute(
            "x1", AGREEMENT, ["only_one"], [DATA_AGENT], [DATA], FINAL, DISPUTE_REASON, "",
        )


def test_chain_rejects_mismatched_lengths(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    with direct_vm.expect_revert("equal length"):
        contract.submit_chain_dispute(
            "x2",
            AGREEMENT,
            ["data_agent", "analyst", "researcher"],
            [DATA_AGENT, ANALYST],  # only 2 agents for 3 roles
            [DATA, PROCESSED, CONCLUSION],
            FINAL,
            DISPUTE_REASON,
            "",
        )


# ======================================================================
# Dispatch (bridge emit) + config. The emit itself is a cross-chain message
# that direct mode only traces; the real delivery is exercised live. Here we
# test the guards and that any culprit's address flows through.
# ======================================================================

def test_get_config_exposes_bridge_wiring(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    cfg = contract.get_config()
    assert cfg["bridge_sender"].lower() == BRIDGE_SENDER.lower()
    assert cfg["escrow_contract"].lower() == ESCROW.lower()
    assert cfg["target_chain_eid"] == TARGET_EID


def test_dispatch_requires_judged_first(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_2(contract)  # open, not judged
    with direct_vm.expect_revert("not judged yet"):
        contract.dispatch_verdict("d1")


def test_dispatch_after_judged_emits_analyst_culprit(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, False, True], "analyst mis-processed")
    contract.judge_dispute("c1")

    r = contract.dispatch_verdict("c1")
    assert r["dispatched"] is True
    assert r["verdict"] == "ANALYST"
    assert r["culpable_agents"] == [ANALYST]  # a middle-of-chain culprit flows to the escrow


def test_set_escrow_contract_owner_only(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only the owner can do this"):
        contract.set_escrow_contract("0x000000000000000000000000000000000000bEEF", TARGET_EID)


# ======================================================================
# v0.4.0 REPUTATION (add-on): counters updated in the same tx as the verdict.
# Only participated/culpable are stored; reliability_pct is derived on read.
# ======================================================================

def test_reputation_no_fault_all_participate_none_culpable(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, True, True], "all correct")
    contract.judge_dispute("c1")

    for a in (DATA_AGENT, ANALYST, RESEARCHER):
        rep = contract.get_reputation(a)
        assert rep["participated"] == 1
        assert rep["culpable"] == 0
        assert rep["reliability_pct"] == 100


def test_reputation_fault_marks_only_the_culprit(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, False, True], "analyst broke it")  # ANALYST culpable
    contract.judge_dispute("c1")

    an = contract.get_reputation(ANALYST)
    assert an["participated"] == 1 and an["culpable"] == 1 and an["reliability_pct"] == 0

    for a in (DATA_AGENT, RESEARCHER):
        rep = contract.get_reputation(a)
        assert rep["participated"] == 1 and rep["culpable"] == 0 and rep["reliability_pct"] == 100


def test_reputation_multiple_culprits_each_credited(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    # Two independent breaks (data agent + researcher); the analyst between them is correct.
    _mock_steps(direct_vm, [False, True, False], "data agent and researcher both broke")
    contract.judge_dispute("c1")

    for a in (DATA_AGENT, RESEARCHER):
        rep = contract.get_reputation(a)
        assert rep["participated"] == 1 and rep["culpable"] == 1 and rep["reliability_pct"] == 0
    an = contract.get_reputation(ANALYST)
    assert an["participated"] == 1 and an["culpable"] == 0 and an["reliability_pct"] == 100


def test_reputation_accumulates_across_disputes(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)

    # Dispute 1: NO_FAULT -> everyone participated once, none culpable.
    _submit_3(contract, "c1")
    _mock_steps(direct_vm, [True, True, True], "ok")
    contract.judge_dispute("c1")

    # Dispute 2: DATA_AGENT at fault.
    direct_vm.clear_mocks()
    _submit_3(contract, "c2")
    _mock_steps(direct_vm, [False, True, True], "bad data")
    contract.judge_dispute("c2")

    da = contract.get_reputation(DATA_AGENT)
    assert da["participated"] == 2 and da["culpable"] == 1 and da["reliability_pct"] == 50  # (2-1)*100//2

    for a in (ANALYST, RESEARCHER):
        rep = contract.get_reputation(a)
        assert rep["participated"] == 2 and rep["culpable"] == 0 and rep["reliability_pct"] == 100


def test_reputation_unknown_agent_is_zero(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    rep = contract.get_reputation("0x9999999999999999999999999999999999999999")
    assert rep["participated"] == 0 and rep["culpable"] == 0 and rep["reliability_pct"] == 0


def test_reputation_lookup_is_case_insensitive(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, True, True], "ok")
    contract.judge_dispute("c1")
    # Query with an uppercased address; keys are stored lowercased.
    rep = contract.get_reputation(ANALYST.upper())
    assert rep["participated"] == 1


def test_leaderboard_lists_all_participants(direct_vm, direct_deploy, direct_owner):
    contract = _deploy(direct_deploy, direct_vm, direct_owner)
    _submit_3(contract)
    _mock_steps(direct_vm, [True, False, True], "analyst broke it")
    contract.judge_dispute("c1")

    board = contract.get_leaderboard()
    agents = {row["agent"] for row in board}
    assert DATA_AGENT in agents and ANALYST in agents and RESEARCHER in agents
    culprit = next(r for r in board if r["agent"] == ANALYST)
    assert culprit["culpable"] == 1
