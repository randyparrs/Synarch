# Synarch

An on-chain economy of autonomous AI agents. Agents are hired in a chain, each one working
from the previous one's output. When the result is disputed, GenLayer validators adjudicate
by reading the real deliverables and naming which link broke, and an escrow on Base settles
the payment accordingly: honest agents keep their share, an at-fault agent's share returns
to the client.

The work and the ruling happen on GenLayer. The money never leaves Base. A single id ties
them together: the same string is the chain id on GenLayer, the agreement id on the escrow
and the dispute id in the judge.

Synarch turns multi-agent work into an accountable economic process: agents are paid for
correct work, disputes are independently adjudicated, and responsibility follows the point
where a chain actually breaks.

The console is live at **https://synarch-ai.netlify.app**. Every number it shows is read
from the contracts themselves, not from a database: browsing needs no wallet, running a
workflow does.


## Architecture

```
GenLayer Studio Next (61997)                    ZKsync Sepolia        Base Sepolia (84532)

  SynarchAgents ──run_next_step──┐
        │                        │
        │  export_for_judge      │
        ▼                        │
  SynarchJudge ──dispatch_verdict┤
        │                        ▼
        └──────────────► SynarchBridgeSender ──► BridgeForwarder ──► BridgeReceiver
                                                    (relay)          (LayerZero)  │
                                                                                  ▼
                                                                          SynarchEscrow
                                                                            (USDC)
```

The bridge carries a message, never funds. The escrow holds the USDC and decides where it
goes from its own records; the message only carries the agreement id, the verdict and the
list of at-fault addresses.

Nothing crosses on its own. `SynarchBridgeSender` only queues the message on GenLayer; an
off-chain relay picks it up, pays the LayerZero fee on ZKsync Sepolia and lets the forwarder
deliver it to Base, where the escrow acts on it. The relay decides nothing and custodies
nothing: it cannot alter a message, invent one or choose who gets paid, and a message it
delivers twice is rejected by the forwarder's used-hash check. It runs as a GitHub Actions
job every five minutes, so a settlement lands minutes after the verdict rather than
instantly. The console shows that gap as the three cross-chain checks on a workflow.

## Deployed contracts

| Contract | Network | Address |
| --- | --- | --- |
| SynarchAgents | GenLayer Studio Next (61997) | `0x21B2b9c92DB2582Aa2cAD02345632387EE34120f` |
| SynarchJudge | GenLayer Studio Next (61997) | `0x81aE27362Fd23c7cF1A1D9b26ff2052E492778a8` |
| SynarchBridgeSender | GenLayer Studio Next (61997) | `0xffe709e5883f5E669D4aBa35d0544269b28ce3d4` |
| SynarchEscrow | Base Sepolia (84532) | `0x7C12C58B7241924e18E8f1aAbD8F7a7E60c3e1FB` |
| BridgeReceiver | Base Sepolia (84532) | `0x0DcBD91EAe6cFa23510FF2da3A3760F55333e382` |
| BridgeForwarder | ZKsync Sepolia (300) | `0xBCa1b17E4e392A7104f964a8426b7c3f945f288d` |
| USDC (test) | Base Sepolia (84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Escrow governance: parameter changes go through a Safe-proposed TimelockController with a
48 hour delay (`0xb60DAaBA66374AdeD183912cFbB9C07c7FccDBaD`). `pause()` is the Safe directly
(`0x19459646bdFb78B7FF6Ca436E037c7F62Af7f878`). There is no owner withdrawal of any kind:
funds leave only through the verdict or refund paths.

Everything runs on testnets. The USDC is test USDC and has no value.

## Repository layout

| Path | Contents |
| --- | --- |
| `contracts/` | GenLayer intelligent contracts: agents, judge, bridge sender |
| `escrow/` | Solidity escrow, its Hardhat tests and its deploy script |
| `relay/` | Off-chain service that moves bridge messages to the forwarder |
| `scripts/` | Deploy, wiring, agent registration and end-to-end scripts |
| `tests/direct/` | Direct-mode tests for the GenLayer contracts |
| `frontend/` | React console for running and inspecting workflows |

## The delegation chain

`SynarchAgents` holds a registry of agents. Each one is owned by its own wallet and carries
four stored prompt fields (`role`, `persona`, `task_template`, `criteria`) that only its
owner can change, so an operator can tune an agent without a redeploy.

`open_chain` registers the delegation order. `run_next_step` runs exactly one agent: the
first receives the agreement, every later one receives the agreement plus the previous
agent's deliverable. Each call is a full consensus round inside the contract, where the
leader produces the work and validators accept it against that agent's `criteria`. The
criteria judge form and relevance, not factual truth, which is what keeps consensus stable
while the wording varies. Factual correctness is the judge's job, later.

Deliverables are committed on GenLayer before the next link starts, so the record of who
produced what is fixed while the chain is still running.

## The adjudication model

`export_for_judge` returns `{agreement, roles[], agents[], delivered[]}`, the exact shape
`submit_chain_dispute` consumes. `judge_dispute` then asks validators for one boolean per
step: is this step's output correct against reality, judged on its own rather than against
the step before it.

The verdict is derived in code from those booleans, never asked of the model:

```python
culpable_indices = [i for i in range(n) if not steps[i] and (i == 0 or steps[i - 1])]
```

A step is at fault when its own output is wrong **and** its input was good. A step that
received a broken deliverable and passed the damage downstream is a victim and keeps a
clean record. Two consequences follow: two consecutive steps can never both be blamed, and
a chain where every step looks wrong blames only the first one. A four-agent chain can
therefore produce zero, one or two independent culprits.

Consensus compares only the set of broken positions, not the wording of the reason, so
validators that explain a fault differently still agree. A committee that fails to converge
returns `NO_MAJORITY`, which is resolved by re-sending to a fresh committee rather than by
polling.

## Reputation

A verdict is the only thing that writes reputation, and it writes it inside the same
transaction that issues it. Every participant of a judged chain gets one participation, and
each independent break gets one fault for the agent it was pinned on.

Only those two counters are stored. Reliability is derived on read as
`(participated - culpable) * 100 / participated` and never saved, so there is no score in
storage for anyone to inflate. There is no setter, no override and no decay: the number
moves only when validators rule on real deliverables.

The record is keyed by the agent's owner address rather than by its agent id, so it follows
the wallet and cannot be shed by re-registering the same operator under a fresh id.
`get_leaderboard` returns the whole table in one call, which is what the console's
Reputation tab reads, together with the rulings behind each percentage: a score can always
be traced back to the disputes that produced it.

## Settlement

An agreement is a dynamic list of deposits, each one `{depositor, beneficiary, amount}`, so
the escrow is agnostic to the number of agents. `dispatch_verdict` sends the ruling across
the bridge, and the escrow resolves every deposit in a single transaction:

- No culprits: every beneficiary is paid.
- With culprits: an at-fault beneficiary's share goes to the `client`, and every other
  beneficiary keeps its own.

Payment requires a verdict. The escrow only moves on a bridged message, so a chain that is
never disputed is never paid; its deposits stay locked until a timeout refund.

The payout rule lives isolated in `_resolveDeposit` so a future model, for instance one that
apportions responsibility along the dependency chain, replaces that function alone without
touching storage or the bridge path.

## Client refunds

A client's USDC is never stranded if a chain does not complete. The agents contract
authorises the refund, because that is where the chain state lives, and dispatches it over
the same bridge:

- **Rule A, cancel.** `cancel_chain` while no step has run. Immediate.
- **Rule B, timeout.** `claim_timeout` while the chain is not complete. Honored by the
  escrow only after `refundTimeout` has elapsed on Base's clock.

A refund returns each share to its recorded **depositor**, never to an address carried in
the message, and it reuses the same one-shot `settled` flag as a verdict. A completed chain
can therefore only be settled by a verdict, and a refunded one can never be settled again.

## Running it

**Prerequisites.** GEN on GenLayer Studio Next, claimed from the faucet at
`studio-next.genlayer.com/contracts`. Base Sepolia ETH for gas and test USDC from
`faucet.circle.com`.

**Console.**

```bash
cd frontend
npm install
npm run dev
```

**Scripts.** Copy `scripts/.env.example` to `scripts/.env` and fill in the keys.

```bash
cd scripts
npm install
npx tsx verify-wiring.ts                  # every cross-contract cable, on all three chains
npx tsx register-agents.ts                # register and configure the agents
npx tsx e2e-fund.ts <id>                  # open and fund an agreement on Base
npx tsx e2e-run-chain.ts <id>             # run the delegation chain
npx tsx e2e-judge.ts <id>                 # submit and adjudicate
npx tsx e2e-dispatch.ts <id>              # send the verdict across the bridge
npx tsx e2e-check.ts <id>                 # read the settlement on Base
npx tsx bridge-diag.ts                    # where a message is in the bridge
```

**Deploying.** The GenLayer CLI does not attach transaction fees on this network and the
node rejects a deploy without them, so deploys go through the SDK:

```bash
cd scripts
GL_ARGS='["<bridge_sender>","<escrow>",40245]' node deploy/deploy-contract.mjs ../contracts/SynarchJudge.py
node deploy/set-escrow.mjs <genlayer_contract> <escrow_address> 40245
```

Order matters. The escrow's `allowedSource` and `allowedRefundSource` are timelocked for 48
hours and its constructor rejects zero addresses, so the GenLayer contracts are deployed
first and the escrow last, with their final addresses in its constructor. The GenLayer side
is then pointed at the escrow with `set_escrow_contract`, which is owner-gated and free.

**Relay.** A GitHub Actions workflow runs a tick every five minutes. To run one locally,
copy `relay/.env.example` to `relay/.env` and:

```bash
cd relay
npm install
npm run build
node dist/index.js --once
```

## Tests

```bash
python -m pytest tests/direct/          # GenLayer contracts, 57 tests
cd escrow && npx hardhat test           # escrow, 21 tests
```

The GenLayer tests need `genlayer-test` 0.30.0rc2 or later, which downloads the v0.6 runner
on first run. The runner hash is pinned on the first line of each contract and must match
the one the node executes.

## Credits and prior work

The cross-chain transport is built on GenLayer Foundation's
[Studio bridge boilerplate](https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate)
(MIT), which provides the LayerZero scaffolding between GenLayer and EVM chains: the
forwarder on ZKsync, the bridge receiver on Base with its interface, and the relay service
that `relay/` is derived from. That work is gratefully credited.

Built on that base, the following is original work: the three intelligent contracts (the
agent registry and its delegation chain, the multi-culprit judge with its reputation
ledger, and the bridge sender), the Solidity escrow with its per-deposit settlement, refund
rules and timelocked governance, the wiring and end-to-end scripts, and the console in
`frontend/`.

## Sources

Documentation this project was built against:

- GenLayer, protocol and intelligent contracts: https://docs.genlayer.com
- Messages from an intelligent contract to the EVM layer:
  https://docs.genlayer.com/developers/intelligent-contracts/features/messages
- Equivalence principle, the rule behind every consensus round here:
  https://docs.genlayer.com/understand-genlayer-protocol/core-concepts/optimistic-democracy/equivalence-principle
- Consensus v0.6 migration notes:
  https://docs.genlayer.com/developers/consensus-v06-migration
- GenLayer on GitHub, tooling and boilerplates: https://github.com/genlayerlabs
- LayerZero V2, the cross-chain message transport: https://docs.layerzero.network
- ZKsync Era, the chain the forwarder runs on: https://docs.zksync.io
- Base, the settlement network: https://docs.base.org
- USDC contract addresses, including test networks:
  https://developers.circle.com/stablecoins/usdc-contract-addresses

## License

MIT. See `LICENSE`.
