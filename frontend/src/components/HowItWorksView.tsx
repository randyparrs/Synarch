import { AGENTS_ADDRESS, JUDGE_ADDRESS, ESCROW_ADDRESS, USDC_ADDRESS } from '../constants';

// Static explainer. The only bound data is the contracts table, which reads the
// real deployed addresses from constants.
const FLOW = [
  { idx: '01', name: 'CREATE', net: 'genlayer', desc: 'You write the agreement and pick the delegation order.' },
  { idx: '02', name: 'FUND', net: 'base', desc: 'One USDC deposit per agent is locked in escrow.' },
  { idx: '03', name: 'CHAIN RUNS', net: 'genlayer', desc: "You run each agent in turn; its deliverable feeds the next one." },
  { idx: '04', name: 'JUDGE', net: 'genlayer', desc: 'Validators rule on the chain. The verdict is what unlocks the money.' },
  { idx: '05', name: 'SETTLE', net: 'base', desc: 'Escrow pays the honest agents and returns the culpable shares to you.' },
  { idx: '06', name: 'REFUND', net: 'base', desc: 'Cancel or timeout returns unspent deposits to you.' },
];

const Tag = ({ children, kind }: { children: string; kind?: 'done' | '' }) => (
  <span className={kind === 'done' ? 'syn-tag syn-tag--done' : 'syn-tag'}>{children}</span>
);
const Call = ({ code, base }: { code: string; base?: boolean }) => (
  <div className="syn-call"><span>{code}</span><Tag kind={base ? '' : 'done'}>{base ? 'BASE' : 'GENLAYER'}</Tag></div>
);

export function HowItWorksView() {
  return (
    <section id="screen-how-it-works">
      <h1>How it works</h1>
      <p className="syn-sub">Two networks, one id. The workflow lives on GenLayer, the money on Base.</p>

      <div className="syn-flow" id="lifecycle-map">
        {FLOW.map((n) => (
          <div className="syn-flow__node" key={n.idx}>
            <div className="syn-flow__idx">{n.idx}</div>
            <div className="syn-flow__name">{n.name}</div>
            <span className="syn-flow__net" data-net={n.net}>{n.net === 'base' ? 'BASE' : 'GENLAYER'}</span>
            <div className="syn-flow__desc">{n.desc}</div>
          </div>
        ))}
      </div>

      <div className="syn-kicker" style={{ margin: '18px 0 9px' }}>THE FULL LIFECYCLE</div>

      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">PHASE 01</span><span className="syn-phase__title">Create the workflow</span><Tag kind="done">GENLAYER + BASE</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p>Open <b>Create Workflow</b> from the sidebar. Write the agreement in plain language, since it is the contract the judge later reads, then pick the agents in the order they should run and set the deposit per agent.</p>
            <p>One id (<span className="syn-inline-code">chain_id</span>) is minted and reused as the agreement id on Base and the dispute id in the judge, so the two networks always talk about the same job.</p>
          </div>
          <div className="syn-calls">
            <Call code="agents.open_chain(chain_id, agreement, client, [ids])" />
            <Call code="escrow.openAgreement(chain_id, client)" base />
            <Call code="USDC.approve(escrow, total)" base />
            <Call code="escrow.deposit(chain_id, agentOwner, amount) x n" base />
          </div>
        </div>
      </article>

      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">PHASE 02</span><span className="syn-phase__title">Agents work in a chain</span><Tag kind="done">GENLAYER</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p>Agents run strictly in order, but they do not run by themselves: <b>you advance the chain one agent at a time</b>. Press <b>Run next step</b> in Overview and sign, and that single agent works. Four agents means four presses and four signatures.</p>
            <p>Each press is a real AI consensus round inside the contract: the leader produces the work and the validators accept it. That takes from seconds to a few minutes, so the stage sits at RUNNING while it happens. When it is your turn again the stage says <b>YOUR TURN</b>.</p>
            <p>Every deliverable is committed on GenLayer before the next link starts, so the record of who produced what cannot be rewritten afterwards. Agents produce <b>analysis</b>, never on-chain trades.</p>
          </div>
          <div className="syn-calls">
            <Call code="agents.run_next_step(chain_id)" />
            <Call code="agents.get_chain(chain_id) -> steps[]" />
            <div className="syn-note">Watch it live on <b>Overview</b>: the pipeline turns green stage by stage, and each agent card shows its output to input handoff.</div>
          </div>
        </div>
      </article>

      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">PHASE 03</span><span className="syn-phase__title">The judge rules, and that is what unlocks the money</span><Tag kind="done">GENLAYER</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p><b>The escrow only moves on a message from GenLayer</b>, and a verdict is the message that pays. So the ruling is not an optional complaint step: it is how a finished chain gets settled. Press <b>Dispute</b> when the chain completes, whether you are happy with the work or not. If everything is correct the verdict is <span className="syn-inline-code">NO_FAULT</span> and all four agents are paid in full.</p>
            <p>Validators read the agreement and every deliverable, and judge each step against reality, not against the step before it. The verdict names <b>every independently broken link</b>, so a chain can have more than one culpable agent.</p>
            <p>An agent that received bad input and passed it on is a <b>victim, not a culprit</b>: it still gets paid. That is why two consecutive steps can never both be blamed, and why a chain where everything failed blames only the first one.</p>
          </div>
          <div className="syn-calls">
            <Call code="judge.submit_chain_dispute(chain_id, ...)" />
            <Call code="judge.judge_dispute(chain_id) -> the ruling" />
            <Call code="judge.get_verdict(chain_id) -> culpable_agents[] | NO_FAULT" />
            <Call code="judge.get_reputation(agent) -> participated, culpable" />
          </div>
        </div>
      </article>

      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">PHASE 04</span><span className="syn-phase__title">Escrow pays, or refunds</span><Tag>BASE SEPOLIA</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p>Press <b>Settle verdict</b> to dispatch the ruling. It crosses to Base over LayerZero, which takes a few minutes, and then the escrow pays <b>every share in a single transaction</b>. You do not claim anything: the contract transfers, and it has no withdraw function of any kind.</p>
            <p>Every honest agent keeps its share. Each culpable agent's share goes back to the <b>client</b>, the party named when the agreement was opened. With <span className="syn-inline-code">NO_FAULT</span>, all four are paid in full.</p>
            <p>If you never dispute, nothing is paid: the deposits stay locked until a timeout refund. The money always leaves through a verdict or through a refund, never on its own.</p>
          </div>
          <div className="syn-calls">
            <Call code="judge.dispatch_verdict(chain_id) -> bridge to Base" />
            <Call code="escrow pays every honest beneficiary" base />
            <Call code="escrow returns each culpable share to the client" base />
          </div>
        </div>
      </article>

      <div className="syn-kicker" style={{ margin: '18px 0 9px' }}>WHAT YOU SIGN, IN ORDER</div>
      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">WALLET</span><span className="syn-phase__title">Every signature a full run asks for</span><Tag kind="done">GENLAYER + BASE</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p>Nothing happens on its own. A four-agent workflow asks you to sign about ten times, on two networks, and your wallet switches between them as needed.</p>
            <ol className="syn-steps-num">
              <li><b>Open the chain</b> on GenLayer: the delegation order is registered.</li>
              <li><b>Open the agreement</b> on Base, under the same id.</li>
              <li><b>Approve USDC</b> once, for the total deposit.</li>
              <li><b>Deposit</b> once per agent, earmarked to that agent's wallet.</li>
              <li><b>Run next step</b>, once per agent. Four agents, four signatures.</li>
              <li><b>Dispute</b> when the chain completes. This is two signatures, submit and judge, and it is what produces the verdict that releases the money.</li>
              <li><b>Settle verdict</b>, one signature, to send the ruling across the bridge.</li>
            </ol>
            <p>After the last one you sign nothing else. The relay carries the message and the escrow pays by itself, within a few minutes.</p>
          </div>
          <div className="syn-calls">
            <div className="syn-note">GEN pays for the GenLayer signatures, Base Sepolia ETH for the Base ones. Both faucets are below.</div>
            <div className="syn-note">A busy node can delay a signature prompt: the app retries and tells you it is waiting rather than failing.</div>
            <div className="syn-note">Changed your mind before the first agent runs? <b>Cancel</b> returns the whole deposit and costs one signature.</div>
          </div>
        </div>
      </article>

      <div className="syn-kicker" style={{ margin: '18px 0 9px' }}>FUNDING YOUR WALLET</div>
      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">FAUCET</span><span className="syn-phase__title">Fund your wallet on GenLayer</span><Tag kind="done">GENLAYER</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <ol className="syn-steps-num">
              <li>Open <code>studio-next.genlayer.com/contracts</code> and connect the same wallet you use here.</li>
              <li>Click the faucet icon in the top bar and claim your test GEN.</li>
              <li>Come back and check the network badge: it shows your GEN balance once the claim lands.</li>
            </ol>
          </div>
          <div className="syn-calls">
            <Call code="chain id 61997" />
            <div className="syn-note">GEN pays for the agent and judge transactions, the ones signed on GenLayer. Test tokens only, no real value.</div>
          </div>
        </div>
      </article>

      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">FAUCET</span><span className="syn-phase__title">Fund your wallet on Base Sepolia</span><Tag>BASE SEPOLIA</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <ol className="syn-steps-num">
              <li>Add <b>Base Sepolia</b> to your wallet, chain id <code>84532</code>.</li>
              <li>Get a little Sepolia ETH for gas from any Base Sepolia faucet.</li>
              <li>Open the <b>Circle testnet faucet</b> at <code>faucet.circle.com</code>, choose <b>Base Sepolia</b>, paste your address and request USDC.</li>
              <li>Import the test USDC token below if your wallet does not show it automatically.</li>
              <li>Come back, connect your wallet, and the deposit step will pass its balance check.</li>
            </ol>
          </div>
          <div className="syn-calls">
            <Call code={`USDC (test) ${USDC_ADDRESS}`} base />
            <Call code="chain id 84532 - 6 decimals" base />
            <div className="syn-note">Test USDC only. Nothing on this network has real value: deposits, payouts and refunds are all testnet.</div>
          </div>
        </div>
      </article>

      <div className="syn-kicker" style={{ margin: '18px 0 9px' }}>GETTING YOUR MONEY BACK</div>
      <article className="syn-phase">
        <div className="syn-phase__head"><span className="syn-phase__num">REFUND</span><span className="syn-phase__title">Where cancel and refund live</span><Tag>BASE SEPOLIA</Tag></div>
        <div className="syn-phase__body">
          <div className="syn-phase__text">
            <p><b>A - Cancel before the first step.</b> Nothing has run yet, so the whole deposit comes back. The <b>Cancel chain</b> action sits on the chain header in <b>Overview</b> and on the workflow row in <b>Workflows</b>.</p>
            <p><b>B - Claim after a timeout.</b> If the chain stalls past <span className="syn-inline-code">refundTimeout</span>, <b>Claim timeout refund</b> appears in <b>Escrow</b> and releases the unspent deposits.</p>
            <p><b>C - Partial refund by verdict.</b> When the judge names culpable agents, their deposits go back to the client automatically at settle, with no action needed. Track it in the <b>Escrow</b> ledger.</p>
          </div>
          <div className="syn-calls">
            <Call code="agents.cancel_chain(chain_id) - before step 1" />
            <Call code="agents.claim_timeout(chain_id) - after refundTimeout" />
            <Call code="escrow.getAgreement(chain_id) -> settled, verdict" base />
          </div>
        </div>
      </article>

      <div className="syn-kicker" style={{ margin: '18px 0 9px' }}>CONTRACTS</div>
      <div className="syn-table" id="contracts-table">
        <div className="syn-table__head"><span className="col-contract" style={{ color: 'inherit' }}>CONTRACT</span><span className="col-network">NETWORK</span><span className="col-address" style={{ color: 'inherit' }}>ADDRESS</span></div>
        <div className="syn-table__row" style={{ cursor: 'default' }}><span className="col-contract">SynarchAgents v0.4.0</span><span className="col-network"><Tag kind="done">GENLAYER</Tag></span><span className="col-address">{AGENTS_ADDRESS}</span></div>
        <div className="syn-table__row" style={{ cursor: 'default' }}><span className="col-contract">SynarchJudge v0.5.0</span><span className="col-network"><Tag kind="done">GENLAYER</Tag></span><span className="col-address">{JUDGE_ADDRESS}</span></div>
        <div className="syn-table__row" style={{ cursor: 'default' }}><span className="col-contract">SynarchEscrow v2</span><span className="col-network"><Tag>BASE</Tag></span><span className="col-address">{ESCROW_ADDRESS}</span></div>
        <div className="syn-table__row" style={{ cursor: 'default' }}><span className="col-contract">USDC (test)</span><span className="col-network"><Tag>BASE</Tag></span><span className="col-address">{USDC_ADDRESS}</span></div>
      </div>
    </section>
  );
}
