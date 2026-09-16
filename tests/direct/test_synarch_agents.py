import os

# Absolute path so the contract is found regardless of the pytest working dir.
CONTRACT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "contracts", "SynarchAgents.py")
)

# DUMMY prompt text, used ONLY to exercise the mechanism in tests. Real agent prompts
# are authored by each operator through the setters; nothing here is a production prompt.
A_ID = "data-agent-1"
A_ROLE = "Data Agent"
A_PERSONA = "TEST persona A: confident"
A_TASK = "You are <<PERSONA>>. Provide data for: <<REQUEST>>"
A_CRITERIA = "TEST criteria A: clear, structured data answer."

B_ID = "researcher-1"
B_ROLE = "Researcher"
B_PERSONA = "TEST persona B: cautious analyst"
B_TASK = "As <<PERSONA>>, conclude about: <<REQUEST>>"
B_CRITERIA = "TEST criteria B: a well-formed conclusion."

REQUEST = "Give the revenue of company X."

# Dummy bridge config for direct-mode (the real emit is exercised live).
BRIDGE_SENDER = "0xBe5D5066e25D87D46A0D881d698eD3d0316479Ae"
ESCROW = "0x000000000000000000000000000000000000dEaD"
TARGET_EID = 40245


def _deploy(direct_deploy, direct_vm, sender):
    direct_vm.sender = sender
    return direct_deploy(CONTRACT, BRIDGE_SENDER, ESCROW, TARGET_EID)


def _register_and_configure(contract, direct_vm, owner, agent_id, role, persona, task, criteria):
    direct_vm.sender = owner
    contract.register_agent(agent_id, role)
    contract.set_persona(agent_id, persona)
    contract.set_task_template(agent_id, task)
    contract.set_criteria(agent_id, criteria)


def _mock_answer(direct_vm, answer):
    direct_vm.mock_llm(r"(?s).*", answer)


def _mock_acceptance(direct_vm, passed):
    direct_vm.mock_llm(r"(?s).*", '{"pass": ' + ("true" if passed else "false") + "}")


# ======================================================================
# Two distinct agents, each with its own owner and personality, coexist.
# ======================================================================

def test_two_agents_registered_with_distinct_owners(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)

    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    _register_and_configure(contract, direct_vm, direct_bob, B_ID, B_ROLE, B_PERSONA, B_TASK, B_CRITERIA)

    pa = contract.get_profile(A_ID)
    pb = contract.get_profile(B_ID)
    assert pa["role"] == A_ROLE and pa["persona"] == A_PERSONA and pa["configured"] is True
    assert pb["role"] == B_ROLE and pb["persona"] == B_PERSONA and pb["configured"] is True
    assert pa["owner"].lower() != pb["owner"].lower()  # different operators
    ids = contract.get_agent_ids()
    assert A_ID in ids and B_ID in ids


# ======================================================================
# Each agent produces work according to ITS OWN persona.
# ======================================================================

def test_each_agent_produces_its_own_work(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    _register_and_configure(contract, direct_vm, direct_bob, B_ID, B_ROLE, B_PERSONA, B_TASK, B_CRITERIA)

    # Agent A (any caller may hire an agent).
    _mock_answer(direct_vm, "A-style: revenue is 120B, structured.")
    ra = contract.produce_work(A_ID, "wa", REQUEST)
    assert ra["agent_id"] == A_ID
    assert "120B" in ra["delivered"]
    assert contract.get_work("wa")["agent_id"] == A_ID

    # Agent B (clear the previous mock so this request hits a fresh answer).
    direct_vm.clear_mocks()
    _mock_answer(direct_vm, "B-style: after review, the conclusion is X.")
    rb = contract.produce_work(B_ID, "wb", REQUEST)
    assert rb["agent_id"] == B_ID
    assert "conclusion" in rb["delivered"]
    assert contract.get_work("wb")["agent_id"] == B_ID


# ======================================================================
# Isolation: agent A's owner cannot edit agent B's prompts.
# ======================================================================

def test_owner_isolation_between_agents(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    _register_and_configure(contract, direct_vm, direct_bob, B_ID, B_ROLE, B_PERSONA, B_TASK, B_CRITERIA)

    # Alice (owner of A) tries to edit B (owned by Bob) -> revert.
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only this agent's owner can do this"):
        contract.set_persona(B_ID, "hijacked persona")

    # Bob cannot edit A either.
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only this agent's owner can do this"):
        contract.set_criteria(A_ID, "hijacked criteria")

    # B's persona is unchanged.
    assert contract.get_profile(B_ID)["persona"] == B_PERSONA


# ======================================================================
# produce_work on an unregistered agent reverts.
# ======================================================================

def test_produce_work_unknown_agent_reverts(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    with direct_vm.expect_revert("Agent not found"):
        contract.produce_work("ghost", "w1", REQUEST)


# ======================================================================
# Fail-safe per agent: registered but not configured -> revert.
# ======================================================================

def test_produce_work_reverts_when_agent_not_configured(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    direct_vm.sender = direct_alice
    contract.register_agent(A_ID, A_ROLE)  # registered, prompts still empty
    with direct_vm.expect_revert("Agent prompt not configured"):
        contract.produce_work(A_ID, "w1", REQUEST)

    # Partially configured (task set, criteria still empty) still reverts.
    contract.set_task_template(A_ID, A_TASK)
    with direct_vm.expect_revert("Agent prompt not configured"):
        contract.produce_work(A_ID, "w1", REQUEST)


# ======================================================================
# Live reconfiguration by the agent's own owner (no redeploy).
# ======================================================================

def test_live_config_by_owner(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    direct_vm.sender = direct_alice
    contract.register_agent(A_ID, A_ROLE)

    assert contract.get_profile(A_ID)["configured"] is False
    contract.set_persona(A_ID, "v1")
    assert contract.get_profile(A_ID)["persona"] == "v1"
    contract.set_persona(A_ID, "v2 tuned")
    assert contract.get_profile(A_ID)["persona"] == "v2 tuned"


# ======================================================================
# preview_prompt injects the markers per agent, without calling the AI.
# ======================================================================

def test_preview_prompt_per_agent(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    direct_vm.sender = direct_alice
    contract.register_agent(A_ID, A_ROLE)
    contract.set_persona(A_ID, "PERSONA_TOKEN")
    contract.set_task_template(A_ID, "Acts as <<PERSONA>> on: <<REQUEST>>")

    preview = contract.preview_prompt(A_ID, "REQUEST_TOKEN")
    assert preview == "Acts as PERSONA_TOKEN on: REQUEST_TOKEN"
    assert "<<PERSONA>>" not in preview and "<<REQUEST>>" not in preview


# ======================================================================
# Consensus per agent: validator accepts/rejects against THAT agent's criteria.
# ======================================================================

def test_validator_accepts_work_meeting_criteria(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)

    _mock_answer(direct_vm, "structured data answer: 120B")
    contract.produce_work(A_ID, "wa", REQUEST)

    direct_vm.clear_mocks()
    _mock_acceptance(direct_vm, True)
    assert direct_vm.run_validator() is True


def test_validator_rejects_work_failing_criteria(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)

    _mock_answer(direct_vm, "unrelated nonsense")
    contract.produce_work(A_ID, "wb", REQUEST)

    direct_vm.clear_mocks()
    _mock_acceptance(direct_vm, False)
    assert direct_vm.run_validator() is False


def test_validator_rejects_empty_leader_work(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)

    _mock_answer(direct_vm, "anything")
    contract.produce_work(A_ID, "wc", REQUEST)
    assert direct_vm.run_validator(leader_result={"work": "   "}) is False


# ======================================================================
# Guardrails.
# ======================================================================

def test_duplicate_agent_id_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    direct_vm.sender = direct_alice
    contract.register_agent(A_ID, A_ROLE)
    # Even a different operator cannot reuse the id.
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Agent id already used"):
        contract.register_agent(A_ID, "Other")


def test_empty_request_rejected(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    with direct_vm.expect_revert("Request is required"):
        contract.produce_work(A_ID, "w1", "   ")


def test_duplicate_work_id_rejected(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    _mock_answer(direct_vm, "some answer")
    contract.produce_work(A_ID, "w4", REQUEST)
    with direct_vm.expect_revert("Work id already used"):
        contract.produce_work(A_ID, "w4", REQUEST)


# ======================================================================
# 4.3 DELEGATION: a job passes through an ordered chain of agents.
# ======================================================================

C_ID = "analyst-1"
C_ROLE = "Analyst"
C_PERSONA = "TEST persona C: processes data"
C_TASK = "As <<PERSONA>>, process: <<REQUEST>>"
C_CRITERIA = "TEST criteria C: a well-formed processed result."

AGREEMENT = "Determine whether company X out-earned company Y last year."


def _setup_three_agents(contract, direct_vm, alice, bob, charlie):
    """data_agent (alice) -> analyst (bob) -> researcher (charlie)."""
    _register_and_configure(contract, direct_vm, alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    _register_and_configure(contract, direct_vm, bob, C_ID, C_ROLE, C_PERSONA, C_TASK, C_CRITERIA)
    _register_and_configure(contract, direct_vm, charlie, B_ID, B_ROLE, B_PERSONA, B_TASK, B_CRITERIA)
    return [A_ID, C_ID, B_ID]  # data_agent -> analyst -> researcher


def test_open_chain_and_run_to_completion(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)

    direct_vm.sender = direct_alice  # a client opens the job
    contract.open_chain("chain-1", AGREEMENT, str(direct_alice), plan)

    c0 = contract.get_chain("chain-1")
    assert c0["status"] == "open" and c0["steps_total"] == 3 and c0["steps_done"] == 0

    # Step 0: the upstream agent receives the agreement itself.
    prev = contract.preview_next_step("chain-1")
    assert prev["next_agent_id"] == A_ID and prev["request"] == AGREEMENT

    _mock_answer(direct_vm, "data: X=120B, Y=62B")
    r0 = contract.run_next_step("chain-1")
    assert r0["step_index"] == 0 and r0["agent_id"] == A_ID and r0["status"] == "open"

    # Step 1: the analyst's request must carry the data agent's deliverable.
    prev1 = contract.preview_next_step("chain-1")
    assert prev1["next_agent_id"] == C_ID
    assert "data: X=120B, Y=62B" in prev1["request"]  # upstream output fed downstream

    direct_vm.clear_mocks()
    _mock_answer(direct_vm, "processed: X leads Y by 58B")
    contract.run_next_step("chain-1")

    # Step 2: the researcher concludes; chain completes.
    prev2 = contract.preview_next_step("chain-1")
    assert prev2["next_agent_id"] == B_ID
    assert "processed: X leads Y by 58B" in prev2["request"]

    direct_vm.clear_mocks()
    _mock_answer(direct_vm, "conclusion: X out-earned Y")
    r2 = contract.run_next_step("chain-1")
    assert r2["step_index"] == 2 and r2["status"] == "complete"

    c = contract.get_chain("chain-1")
    assert c["status"] == "complete" and c["steps_done"] == 3
    assert [s["agent_id"] for s in c["steps"]] == [A_ID, C_ID, B_ID]


def test_export_for_judge_shape(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    direct_vm.sender = direct_alice
    contract.open_chain("chain-x", AGREEMENT, str(direct_alice), plan)

    _mock_answer(direct_vm, "d0")
    contract.run_next_step("chain-x")
    direct_vm.clear_mocks(); _mock_answer(direct_vm, "d1")
    contract.run_next_step("chain-x")
    direct_vm.clear_mocks(); _mock_answer(direct_vm, "d2")
    contract.run_next_step("chain-x")

    exp = contract.export_for_judge("chain-x")
    assert exp["agreement"] == AGREEMENT
    assert exp["roles"] == [A_ROLE, C_ROLE, B_ROLE]
    assert len(exp["agents"]) == 3 and len(exp["delivered"]) == 3
    assert exp["delivered"] == ["d0", "d1", "d2"]
    # export shape (agreement + equal-length roles/agents/delivered) is exactly what
    # SynarchJudge.submit_chain_dispute consumes: the decoupled bridge to the judge.
    assert len(exp["roles"]) == len(exp["agents"]) == len(exp["delivered"])
    # Each agent address is the registering owner (payable/penalizable identity).
    assert exp["agents"][0] == contract.get_profile(A_ID)["owner"]
    assert exp["agents"][1] == contract.get_profile(C_ID)["owner"]
    assert exp["agents"][2] == contract.get_profile(B_ID)["owner"]


def test_open_chain_rejects_unregistered_agent(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    with direct_vm.expect_revert("Agent not found in plan"):
        contract.open_chain("c", AGREEMENT, str(direct_alice), [A_ID, "ghost"])


def test_open_chain_requires_two_agents(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    with direct_vm.expect_revert("at least 2 agents"):
        contract.open_chain("c", AGREEMENT, str(direct_alice), [A_ID])


def test_run_step_fails_if_agent_in_plan_unconfigured(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    _register_and_configure(contract, direct_vm, direct_alice, A_ID, A_ROLE, A_PERSONA, A_TASK, A_CRITERIA)
    direct_vm.sender = direct_bob
    contract.register_agent(B_ID, B_ROLE)  # registered but NOT configured
    direct_vm.sender = direct_alice
    contract.open_chain("c", AGREEMENT, str(direct_alice), [A_ID, B_ID])

    _mock_answer(direct_vm, "d0")
    contract.run_next_step("c")  # step 0 (A) ok
    direct_vm.clear_mocks(); _mock_answer(direct_vm, "d1")
    with direct_vm.expect_revert("Agent prompt not configured"):
        contract.run_next_step("c")  # step 1 (B unconfigured) fails safe


def test_run_step_reverts_on_complete_and_unknown(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    direct_vm.sender = direct_alice
    contract.open_chain("c", AGREEMENT, str(direct_alice), plan)
    for d in ("d0", "d1", "d2"):
        direct_vm.clear_mocks(); _mock_answer(direct_vm, d)
        contract.run_next_step("c")
    with direct_vm.expect_revert("Chain is not open"):
        contract.run_next_step("c")
    with direct_vm.expect_revert("Chain not found"):
        contract.run_next_step("ghost-chain")


def test_duplicate_chain_id_rejected(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    direct_vm.sender = direct_alice
    contract.open_chain("dup", AGREEMENT, str(direct_alice), plan)
    with direct_vm.expect_revert("Chain id already used"):
        contract.open_chain("dup", AGREEMENT, str(direct_alice), plan)


# ======================================================================
# Judge-readiness: the exported chain is exactly the input the SynarchJudge's
# submit_chain_dispute(dispute_id, agreement, roles, agents, delivered, ...) consumes.
# NOTE: direct-mode loads only ONE contract per process, so a live cross-contract
# call (agents -> judge) cannot run here; that end-to-end is exercised on Bradbury.
# Here we lock the SHAPE contract that connects the two (same chain_id = dispute_id).
# ======================================================================

def test_export_is_judge_submit_chain_shape(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    direct_vm.sender = direct_alice
    contract.open_chain("job-1", AGREEMENT, str(direct_alice), plan)
    for d in ("raw data", "processed data", "final conclusion"):
        direct_vm.clear_mocks(); _mock_answer(direct_vm, d)
        contract.run_next_step("job-1")

    exp = contract.export_for_judge("job-1")
    # The judge's submit_chain_dispute needs: agreement (str) + 3 parallel, equal-length,
    # non-empty lists in chain order. The chain_id doubles as the dispute_id.
    assert isinstance(exp["agreement"], str) and exp["agreement"]
    assert exp["status"] == "complete"
    n = len(exp["roles"])
    assert n == 3
    assert len(exp["agents"]) == n and len(exp["delivered"]) == n
    assert all(isinstance(r, str) and r for r in exp["roles"])
    assert all(isinstance(a, str) and a for a in exp["agents"])
    # First-break attribution would map exp["agents"][i] -> culpable owner address.
    assert exp["agents"][1] == contract.get_profile(C_ID)["owner"]  # the analyst's owner


# ======================================================================
# 4.4 CLIENT REFUND (rule A + B). Authorized here (chain state lives here) and
# dispatched to the escrow via the async bridge. Direct-mode traces the emit; the
# actual USDC refund is tested on the escrow (Hardhat). Here: guards + auth + status.
# ======================================================================

def _client_addr(contract, agent_id):
    """The address string exactly as the contract records it (matches gl.message.sender)."""
    return contract.get_profile(agent_id)["owner"]


def test_config_and_admin_gated_setters(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)  # alice is admin (deployer)
    cfg = contract.get_config()
    assert cfg["bridge_sender"].lower() == BRIDGE_SENDER.lower()
    assert cfg["escrow_contract"].lower() == ESCROW.lower()
    assert cfg["target_chain_eid"] == TARGET_EID

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only the admin can do this"):
        contract.set_escrow_contract("0x000000000000000000000000000000000000bEEF", TARGET_EID)


def test_cancel_chain_before_first_step(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    client = _client_addr(contract, A_ID)  # alice, in the contract's address format

    direct_vm.sender = direct_alice
    contract.open_chain("ch", AGREEMENT, client, plan)

    r = contract.cancel_chain("ch")  # intact chain, alice is the client
    assert r["status"] == "cancelled" and r["action"] == "refund_cancel"
    assert contract.get_chain("ch")["status"] == "cancelled"
    # A cancelled chain can no longer run steps.
    with direct_vm.expect_revert("Chain is not open"):
        contract.run_next_step("ch")


def test_cancel_rejected_after_work_started(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    client = _client_addr(contract, A_ID)
    direct_vm.sender = direct_alice
    contract.open_chain("ch", AGREEMENT, client, plan)

    _mock_answer(direct_vm, "d0")
    contract.run_next_step("ch")  # a step ran -> no longer intact
    with direct_vm.expect_revert("work already started"):
        contract.cancel_chain("ch")


def test_cancel_only_by_client(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    client = _client_addr(contract, A_ID)  # alice
    direct_vm.sender = direct_alice
    contract.open_chain("ch", AGREEMENT, client, plan)

    direct_vm.sender = direct_bob  # not the client
    with direct_vm.expect_revert("Only the chain client"):
        contract.cancel_chain("ch")


def test_claim_timeout_on_stalled_chain(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    client = _client_addr(contract, A_ID)
    direct_vm.sender = direct_alice
    contract.open_chain("ch", AGREEMENT, client, plan)

    _mock_answer(direct_vm, "d0")
    contract.run_next_step("ch")  # started but not complete (stalled)

    r = contract.claim_timeout("ch")  # dispatch; escrow enforces the actual timeout
    assert r["action"] == "refund_timeout" and r["status"] == "open"


def test_claim_timeout_rejected_on_complete_chain(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    client = _client_addr(contract, A_ID)
    direct_vm.sender = direct_alice
    contract.open_chain("ch", AGREEMENT, client, plan)
    for d in ("d0", "d1", "d2"):
        direct_vm.clear_mocks(); _mock_answer(direct_vm, d)
        contract.run_next_step("ch")
    # A completed chain must settle by verdict, never by refund (protects the agents).
    with direct_vm.expect_revert("completed chain settles by verdict"):
        contract.claim_timeout("ch")


def test_claim_timeout_only_by_client(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    plan = _setup_three_agents(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    client = _client_addr(contract, A_ID)
    direct_vm.sender = direct_alice
    contract.open_chain("ch", AGREEMENT, client, plan)
    _mock_answer(direct_vm, "d0")
    contract.run_next_step("ch")

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only the chain client"):
        contract.claim_timeout("ch")


def test_refund_reverts_on_unknown_chain(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy, direct_vm, direct_alice)
    with direct_vm.expect_revert("Chain not found"):
        contract.cancel_chain("ghost")
    with direct_vm.expect_revert("Chain not found"):
        contract.claim_timeout("ghost")

