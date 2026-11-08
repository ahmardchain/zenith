// The four off-chain roles that make the optimistic game run:
//   solver  — answers OPEN requests with an AI verdict + bond
//   watcher — re-checks every PROPOSED answer and challenges if it disagrees
//   jury    — three independent models vote on CHALLENGED requests
//   keeper  — permissionless cranks: finalize, expire disputes, settle escrow jobs
import anchor from "@coral-xyz/anchor";
const { BN } = anchor;
type Program = InstanceType<typeof anchor.Program>;
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  JOB,
  STATUS,
  chainNow,
  configPda,
  fetchConfig,
  fetchRequests,
  log,
  programs,
  roleKeypair,
  short,
  sol,
  vaultPda,
  type JobAccount,
} from "./common.ts";
import { VERDICT_CODE, VERDICT_NAME, fitReasoning, flip, judge, type Judgment } from "./llm.ts";

export type SolverMode = "honest" | "evil" | "naive";
export type Role = "solver" | "watcher" | "jury" | "keeper";

export const state = {
  solverMode: (process.env.SOLVER_MODE as SolverMode) ?? "honest",
};

const env = (k: string, d: string) => process.env[k] || d;
const handled = new Set<string>();

/** Mark work as done; if it fails for a retryable reason, allow a retry next tick. */
async function once(key: string, fn: () => Promise<void>) {
  handled.add(key);
  try {
    await fn();
  } catch (e: any) {
    if (!/WrongStatus|AlreadyVoted|ChallengeWindowClosed/.test(String(e?.message ?? e))) handled.delete(key);
    throw e;
  }
}

async function solverTick(oracle: Program, me: Keypair) {
  for (const { publicKey, account } of await fetchRequests(oracle, STATUS.OPEN)) {
    const key = `solve:${publicKey}`;
    if (handled.has(key)) continue;
    await once(key, async () => {
    const mode = state.solverMode;
    let j: Judgment = await judge(account.prompt, env("SOLVER_MODEL", "openai/gpt-4o-mini"), mode === "naive" ? "naive" : "robust");
    if (mode === "evil") j = { ...j, verdict: flip(j.verdict), reasoning: `(evil) ${j.reasoning}` };

    await oracle.methods
      .propose(VERDICT_CODE[j.verdict], fitReasoning(j.reasoning))
      .accountsPartial({ proposer: me.publicKey, request: publicKey })
      .rpc();
    log("solver", `${short(publicKey)} → ${j.verdict} (bond ${sol(account.bond)} SOL, ${mode}) — ${j.reasoning}`);
    });
  }
}

async function watcherTick(oracle: Program, me: Keypair) {
  const now = await chainNow();
  for (const { publicKey, account } of await fetchRequests(oracle, STATUS.PROPOSED)) {
    const key = `watch:${publicKey}:${account.proposedAt}`;
    if (handled.has(key)) continue;
    const deadline = account.proposedAt.toNumber() + account.windowSecs.toNumber();
    if (now >= deadline || account.proposer.equals(me.publicKey)) {
      handled.add(key);
      continue;
    }
    await once(key, async () => {
    const j = await judge(account.prompt, env("WATCHER_MODEL", "anthropic/claude-sonnet-4.5"), "robust");
    const proposed = VERDICT_NAME[account.proposedVerdict];
    if (j.verdict === proposed) {
      log("watcher", `${short(publicKey)} agrees with ${proposed} — no challenge`);
      return;
    }
    await oracle.methods
      .challenge(VERDICT_CODE[j.verdict], fitReasoning(j.reasoning))
      .accountsPartial({ challenger: me.publicKey, request: publicKey })
      .rpc();
    log("watcher", `${short(publicKey)} CHALLENGED: ${proposed} → ${j.verdict} — ${j.reasoning}`);
    });
  }
}

async function juryTick(oracle: Program, jurors: Keypair[], juryPrograms: Program[]) {
  const config = await fetchConfig(oracle);
  for (const { publicKey } of await fetchRequests(oracle, STATUS.CHALLENGED)) {
    for (let i = 0; i < jurors.length; i++) {
      const slot = config.jurors.findIndex((j) => j.equals(jurors[i].publicKey));
      if (slot < 0) continue;
      const key = `vote:${publicKey}:${slot}`;
      if (handled.has(key)) continue;

      // Re-read before every vote: the previous vote may have settled it.
      const req = (await (oracle.account as any).request.fetch(publicKey)) as Awaited<ReturnType<typeof fetchRequests>>[number]["account"];
      if (req.status !== STATUS.CHALLENGED) break;
      if (req.votes[slot] !== 0) {
        handled.add(key);
        continue;
      }
      await once(key, async () => {
      const model = env(`JUROR${slot + 1}_MODEL`, ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1-mini", "meta-llama/llama-3.3-70b-instruct"][slot]);
      const j = await judge(req.prompt, model, "robust");
      await juryPrograms[i].methods
        .vote(VERDICT_CODE[j.verdict])
        .accountsPartial({
          juror: jurors[i].publicKey,
          config: configPda(),
          request: publicKey,
          proposer: req.proposer,
          challenger: req.challenger,
        })
        .rpc();
      log("jury", `${short(publicKey)} juror ${slot + 1} (${model}) votes ${j.verdict}`);
      });
    }
  }
}

async function keeperTick(oracle: Program, escrow: Program, me: Keypair) {
  const now = await chainNow();

  for (const { publicKey, account } of await fetchRequests(oracle, STATUS.PROPOSED)) {
    if (now < account.proposedAt.toNumber() + account.windowSecs.toNumber()) continue;
    await oracle.methods.finalize().accountsPartial({ request: publicKey, proposer: account.proposer }).rpc();
    log("keeper", `${short(publicKey)} FINALIZED unchallenged → ${VERDICT_NAME[account.proposedVerdict]}; solver paid`);
  }

  for (const { publicKey, account } of await fetchRequests(oracle, STATUS.CHALLENGED)) {
    if (now < account.challengedAt.toNumber() + account.juryTimeoutSecs.toNumber()) continue;
    await oracle.methods
      .expireDispute()
      .accountsPartial({
        request: publicKey,
        proposer: account.proposer,
        challenger: account.challenger,
        requester: account.requester,
      })
      .rpc();
    log("keeper", `${short(publicKey)} jury timed out → bonds refunded`);
  }

  const jobs = (await (escrow.account as any).job.all()) as { publicKey: PublicKey; account: JobAccount }[];
  for (const { publicKey: job, account } of jobs) {
    if (account.status !== JOB.SUBMITTED) continue;
    const req = await (oracle.account as any).request.fetchNullable(account.request);
    if (!req || (req.status !== STATUS.FINALIZED && req.status !== STATUS.CANCELLED)) continue;

    const mintInfo = await escrow.provider.connection.getAccountInfo(account.mint);
    if (!mintInfo) continue;
    const tokenProgram = mintInfo.owner;
    const clientToken = getAssociatedTokenAddressSync(account.mint, account.client, true, tokenProgram);
    const freelancerToken = getAssociatedTokenAddressSync(account.mint, account.freelancer, true, tokenProgram);

    await escrow.methods
      .settle()
      .accountsPartial({
        job,
        request: account.request,
        mint: account.mint,
        vault: vaultPda(job),
        clientToken,
        freelancerToken,
        tokenProgram,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(me.publicKey, clientToken, account.client, account.mint, tokenProgram),
        createAssociatedTokenAccountIdempotentInstruction(me.publicKey, freelancerToken, account.freelancer, account.mint, tokenProgram),
      ])
      .rpc();
    const outcome =
      req.status === STATUS.CANCELLED ? "reopened (oracle cancelled)" : req.finalVerdict === 1 ? "PAID freelancer" : "REFUNDED client";
    log("keeper", `job ${short(job)} settled → ${outcome}`);
  }
}

/** Run the selected roles on a polling loop. Returns a stop() function. */
export function startNodes(roles: Role[] = ["solver", "watcher", "jury", "keeper"], intervalMs = Number(process.env.POLL_MS ?? 6000)) {
  const solver = roleKeypair("solver");
  const watcher = roleKeypair("watcher");
  const keeper = roleKeypair("keeper");
  const jurors = [roleKeypair("juror1"), roleKeypair("juror2"), roleKeypair("juror3")];

  const p = {
    solver: programs(solver),
    watcher: programs(watcher),
    keeper: programs(keeper),
    jurors: jurors.map((j) => programs(j).oracle),
  };

  let running = true;
  const loop = async (role: Role, fn: () => Promise<void>) => {
    while (running) {
      try {
        await fn();
      } catch (e: any) {
        const msg = String(e?.message ?? e).split("\n")[0];
        if (!/WrongStatus|AlreadyVoted|ChallengeWindowClosed|already in use/.test(msg)) log(role, `error: ${msg}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  if (roles.includes("solver")) loop("solver", () => solverTick(p.solver.oracle, solver));
  if (roles.includes("watcher")) loop("watcher", () => watcherTick(p.watcher.oracle, watcher));
  if (roles.includes("jury")) loop("jury", () => juryTick(p.keeper.oracle, jurors, p.jurors));
  if (roles.includes("keeper")) loop("keeper", () => keeperTick(p.keeper.oracle, p.keeper.escrow, keeper));

  log("nodes", `running ${roles.join(", ")} | solver mode: ${state.solverMode} | LLM: ${process.env.LLM_API_KEY ? process.env.LLM_BASE_URL : "MOCK"}`);
  return () => {
    running = false;
  };
}

export { BN };
