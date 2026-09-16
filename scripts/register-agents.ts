#!/usr/bin/env npx tsx
/**
 * Register + configure the 4 Synarch agents MULTI-OWNER: each agent is registered and
 * configured with ITS OWN wallet, so ownership (and the fault-based payout split) is
 * real. Idempotent: re-run safely after a rate-limit (-32005); already-registered
 * agents are skipped and setters only re-apply fields that differ.
 *
 * The old single-owner ids (data-agent / analyst / researcher, owned by the deployer)
 * already exist on-chain and cannot be reused, so these use the "-mo" suffix.
 *
 * Each agent's private key comes from the local .env (NEVER pass keys in chat):
 *   DATA_AGENT_PK, ANALYST_PK, RESEARCHER_PK, STRATEGIST_PK
 * On Studio Next (chain 61997) the node does not debit, so the wallets need no balance.
 *
 * Usage (from synarch/scripts):
 *   npx tsx register-agents.ts
 */
import { createAccount, createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';
import { TransactionStatus, type TransactionHash } from 'genlayer-js/types';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const AGENTS = '0x21B2b9c92DB2582Aa2cAD02345632387EE34120f' as `0x${string}`;
const RPC = process.env.GENLAYER_RPC_URL || 'https://studio-next.genlayer.com/api';
const SAMPLE = "What was Netflix's total revenue in its most recent reported fiscal year?";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AgentDef {
  id: string;
  role: string;
  pkEnv: string; // .env var holding this agent's private key
  persona: string;
  task_template: string;
  criteria: string;
}

const A1_PERSONA =
  'You are a Confident Analyst. You provide concrete, specific figures quickly and in a structured, ' +
  'professional manner. Your defining trait is that you sound authoritative and convincing at all ' +
  'times. You commit fully to the figures you provide, stating them plainly and without hedging, as ' +
  'a seasoned analyst would. Your answers always sound professional and precise, whether or not a ' +
  'given figure is exact.';

const A2_PERSONA =
  'You are a Methodical Analyst. You receive data from an upstream source and your job is to ' +
  'analyze and validate it before it moves forward. You are structured and thorough: you assess ' +
  'whether the data supports the task and you perform the reasoning needed to move it forward. You ' +
  'commit to a clear analytical read of what the data means. Your defining trait is that you ' +
  'produce a confident, structured interpretation of the numbers you are given, drawing the ' +
  'comparison or judgment the task asks for and stating what the data supports. You reason fully ' +
  'and hand down a definite analytical conclusion rather than hedging.';

const A3_PERSONA =
  'You are a Decisive Synthesizer. You receive analysis from an upstream agent and your job is to ' +
  'synthesize it into a clear, actionable conclusion. You are excellent at pulling insights ' +
  'together and producing a decisive answer a client can act on. You value clarity and ' +
  'actionability. Your defining trait is that you commit to a definite conclusion and state it ' +
  'plainly: you take what the upstream analysis gives you and turn it into a firm finding the ' +
  'client can rely on, expressed with confidence. You deliver a clear-cut conclusion rather than a ' +
  'hedged one.';

const A4_PERSONA =
  'You are a Strategist. You receive the final research conclusion from an upstream agent and your ' +
  'job is to turn it into a concrete decision or course of action. You are pragmatic and decisive: ' +
  'you take a clear position and recommend a specific action, not a vague observation. You weigh ' +
  'trade-offs, costs, and context, and you commit to the course of action you judge best. Your ' +
  'defining trait is decisiveness: you deliver a firm, specific recommendation the client can act ' +
  'on immediately, taking a clear stance rather than listing options. You commit to a definite ' +
  'call.';

const AGENT_DEFS: AgentDef[] = [
  {
    id: 'data-agent-mo',
    role: 'Data Agent',
    pkEnv: 'DATA_AGENT_PK',
    persona: A1_PERSONA,
    task_template:
      'You are a data provider agent with the following persona:\n<<PERSONA>>\n\n' +
      'A client has requested the following corporate data:\n<<REQUEST>>\n\n' +
      'Provide the requested data (such as revenue, number of employees, founding date, or market ' +
      'capitalization) as concrete, specific figures, in your characteristic confident and structured ' +
      'style. Give a direct answer with the relevant figures, as you naturally would.',
    criteria:
      'Accept the response if it provides a clear, well-formed, and professional answer that directly ' +
      'addresses the corporate data requested, with specific figures and in a structured style ' +
      "consistent with the agent's persona. Judge only the form, clarity, and relevance of the " +
      'response, NOT whether the figures are factually correct.',
  },
  {
    id: 'analyst-mo',
    role: 'Analyst',
    pkEnv: 'ANALYST_PK',
    persona: A2_PERSONA,
    task_template:
      'You are an analyst agent with the following persona:\n<<PERSONA>>\n\n' +
      'You received the following input to analyze (this includes the original task and the data ' +
      'provided by the upstream agent):\n<<REQUEST>>\n\n' +
      'Analyze and validate the input in your characteristic methodical, structured style. Assess ' +
      'whether the data is sufficient and well-supported, perform any needed reasoning carefully, and ' +
      'produce your analysis. State clearly what the data supports and any concerns about its ' +
      'sufficiency, as you naturally would.',
    criteria:
      'Accept the response if it provides a clear, well-formed, and methodical analysis that directly ' +
      'engages with the input data, assesses whether it supports the task, and reaches a definite ' +
      "analytical conclusion consistent with the agent's methodical and committed persona. Judge only " +
      'the form, clarity, rigor, and relevance of the analysis, NOT whether its conclusions are ' +
      'factually correct.',
  },
  {
    id: 'researcher-mo',
    role: 'Researcher',
    pkEnv: 'RESEARCHER_PK',
    persona: A3_PERSONA,
    task_template:
      'You are a researcher agent with the following persona:\n<<PERSONA>>\n\n' +
      'You received the following input to synthesize into a final conclusion (this includes the ' +
      'original task and the analysis provided by the upstream agent):\n<<REQUEST>>\n\n' +
      'Synthesize the input into a clear, actionable conclusion or recommendation in your ' +
      'characteristic decisive style. Deliver a direct final answer to the client\'s original ' +
      'question, as you naturally would.',
    criteria:
      'Accept the response if it provides a clear, well-formed, and actionable conclusion that directly ' +
      "answers the client's original question and synthesizes the upstream analysis, consistent with the " +
      "agent's decisive persona. Judge only the form, clarity, decisiveness, and relevance of the " +
      'conclusion, NOT whether it is factually correct or appropriately calibrated to the evidence.',
  },
  {
    id: 'strategist-mo',
    role: 'Strategist',
    pkEnv: 'STRATEGIST_PK',
    persona: A4_PERSONA,
    task_template:
      'You are a strategist agent with the following persona:\n<<PERSONA>>\n\n' +
      'You received the following input to turn into a decision (this includes the original task and the ' +
      'research conclusion provided by the upstream agent):\n<<REQUEST>>\n\n' +
      'Turn the input into a concrete, actionable recommendation in your characteristic pragmatic style. ' +
      'Weigh the trade-offs and give a clear course of action connected to the research findings, ' +
      'distinguishing what is evidence-backed from what depends on assumptions, as you naturally would.',
    criteria:
      'Accept the response if it provides a clear, well-formed, and actionable recommendation that ' +
      'connects to the upstream research findings and weighs relevant trade-offs, consistent with the ' +
      "agent's pragmatic and decisive persona. Judge only the form, clarity, actionability, and relevance " +
      'of the recommendation, NOT whether it is factually correct or optimally calibrated to the risks.',
  },
];

function extractPk(raw: string): `0x${string}` {
  // A private key is exactly 0x + 64 hex chars. Extract it and ignore any trailing
  // text (e.g. a stray comment left on the .env line). This never matches a 0x
  // address (40 hex), so a comment mentioning the wallet address is safely ignored.
  const withPrefix = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
  const m = withPrefix.match(/0x[0-9a-fA-F]{64}/);
  if (!m) throw new Error('No valid 0x+64-hex private key found in the value; check the .env line (nothing after the key)');
  return m[0] as `0x${string}`;
}

let FEES: { distribution: unknown; feeValue: unknown } | null = null;

async function ensureFees(client: any) {
  if (!FEES) {
    const est = await client.estimateTransactionFees({
      leaderTimeunitsAllocation: 100,
      validatorTimeunitsAllocation: 200,
      appealRounds: 0,
      executionBudgetPerRound: 25000000000000000n,
      totalMessageFees: 0,
      rotations: [3],
    });
    FEES = { distribution: est.distribution, feeValue: est.feeValue };
  }
  return FEES;
}

function clientFor(pk: string) {
  const norm = extractPk(pk);
  const account = createAccount(norm);
  const client = createClient({
    chain: studioDevnet,
    endpoint: RPC,
    account,
  });

  async function send(fn: string, args: any[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        const fees = await ensureFees(client);
        const hash = await client.writeContract({ address: AGENTS, functionName: fn, args, value: 0n, fees: fees as any });
        await client.waitForTransactionReceipt({ hash: hash as TransactionHash, status: TransactionStatus.ACCEPTED, retries: 60 });
        await sleep(3500);
        return hash as string;
      } catch (e: any) {
        const msg = String(e?.message || e);
        // Idempotent success: the write already landed (e.g. register on a re-send).
        if (/already used|already registered/i.test(msg)) {
          console.log('    (already applied, continuing)');
          return 'already';
        }
        // Transient on a saturated node: rate limit, transient revert, or a receipt
        // wait that timed out (the tx often still finalizes; re-sending is safe here
        // because register is idempotent-guarded and setters just re-apply the value).
        const transient = /-32005|capacity|reverted|was reverted|timed out|reach status|current status/i.test(msg);
        if (transient && attempt < 15) {
          const wait = Math.min(20000, 2500 * attempt);
          console.log(`    (transient, retry ${attempt} in ${wait}ms): ${msg.slice(0, 90)}`);
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
  }
  const read = (fn: string, args: any[] = []) => client.readContract({ address: AGENTS, functionName: fn, args });
  return { client, send, read };
}

async function main() {
  // Read client (deployer) just for the final previews.
  const deployerPk = process.env.PRIVATE_KEY;
  if (!deployerPk) throw new Error('Missing PRIVATE_KEY (synarch/scripts/.env)');
  const readOnly = clientFor(deployerPk);

  const existing: string[] = (await readOnly.read('get_agent_ids')) as string[];
  console.log('Configuring 4 MULTI-OWNER agents on', AGENTS);
  console.log('Already registered:', existing.length ? existing.join(', ') : '(none)', '\n');

  for (const a of AGENT_DEFS) {
    const pk = process.env[a.pkEnv];
    if (!pk) throw new Error(`Missing ${a.pkEnv} in .env (private key for agent "${a.id}", ${a.role})`);
    const { send, read } = clientFor(pk);
    console.log(`Agent "${a.id}" (${a.role}) -- signed by its own wallet:`);

    let cur: any = { role: '', persona: '', task_template: '', criteria: '' };
    if (existing.includes(a.id)) {
      cur = await read('get_profile', [a.id]);
      console.log('  already registered, checking config');
    } else {
      console.log('  register_agent...');
      await send('register_agent', [a.id, a.role]);
    }

    const fields: Array<[string, string, string]> = [
      ['set_role', a.role, String(cur.role)],
      ['set_persona', a.persona, String(cur.persona)],
      ['set_task_template', a.task_template, String(cur.task_template)],
      ['set_criteria', a.criteria, String(cur.criteria)],
    ];
    for (const [fn, want, have] of fields) {
      if (have === want) {
        console.log(`  ${fn}: already set, skip`);
        continue;
      }
      console.log(`  ${fn}...`);
      await send(fn, [a.id, want]);
    }
    console.log('  done\n');
  }

  console.log('================ PREVIEWS (assembled, no AI) ================');
  for (const a of AGENT_DEFS) {
    const profile: any = await readOnly.read('get_profile', [a.id]);
    const preview: string = (await readOnly.read('preview_prompt', [a.id, SAMPLE])) as string;
    console.log(`\n--- ${a.id} (${profile.role}) | owner=${profile.owner} | configured=${profile.configured} ---`);
    console.log(preview.slice(0, 600) + (preview.length > 600 ? '\n...[truncated]' : ''));
  }
  console.log('\nAll 4 multi-owner agents registered and configured.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nregister-agents failed:', e);
  process.exit(1);
});
