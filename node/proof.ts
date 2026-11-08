// Writes docs/DEVNET-PROOF.md from live on-chain data: every oracle request and
// escrow job with its outcome and an explorer link.  Usage: npm run proof
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ESCROW_ID,
  JOB_NAME,
  ORACLE_ID,
  ROOT,
  STATUS_NAME,
  programs,
  roleKeypair,
  sol,
  type JobAccount,
  type RequestAccount,
} from "./common.ts";
import { VERDICT_NAME, splitPrompt } from "./llm.ts";

const NONE = "11111111111111111111111111111111";
const ex = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const { oracle, escrow } = programs(roleKeypair("keeper"));

const requests = (await (oracle.account as any).request.all()) as { publicKey: any; account: RequestAccount }[];
const jobs = (await (escrow.account as any).job.all()) as { publicKey: any; account: JobAccount }[];
const jobBy = new Map(jobs.map((j) => [j.publicKey.toBase58(), j]));
requests.sort((a, b) => a.account.createdAt.toNumber() - b.account.createdAt.toNumber());

const rows = requests.map(({ publicKey, account: r }) => {
  const k = publicKey.toBase58();
  const disputed = r.challenger.toBase58() !== NONE;
  const job = jobBy.get(r.subject.toBase58());
  const { deliverable } = splitPrompt(r.prompt);
  const short = deliverable.length > 60 ? deliverable.slice(0, 57) + "…" : deliverable;
  const votes = disputed ? r.votes.map((v) => VERDICT_NAME[v]).join(" / ") : "not needed";
  const escrowOutcome = job ? JOB_NAME[job.account.status] : "—";
  return `| [${k.slice(0, 4)}…${k.slice(-4)}](${ex(k)}) | ${short.replace(/\|/g, "/").replace(/\n/g, " ")} | ${VERDICT_NAME[r.proposedVerdict]} | ${disputed ? VERDICT_NAME[r.challengedVerdict] : "—"} | ${votes} | **${STATUS_NAME[r.status]} ${VERDICT_NAME[r.finalVerdict]}** | ${escrowOutcome} |`;
});

const md = `# Devnet proof

Generated from live on-chain data by \`npm run proof\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.

| | Address |
|---|---|
| Oracle program | [\`${ORACLE_ID}\`](${ex(ORACLE_ID.toBase58())}) |
| Escrow program | [\`${ESCROW_ID}\`](${ex(ESCROW_ID.toBase58())}) |

## Oracle requests

Bond per side: ${requests[0] ? sol(requests[0].account.bond) : "?"} SOL. "Challenge" is the watcher's counter-verdict; votes are jurors 1/2/3.

| Request | Deliverable | Solver | Challenge | Jury votes | Final | Escrow |
|---|---|---|---|---|---|---|
${rows.join("\n")}
`;

mkdirSync(resolve(ROOT, "docs"), { recursive: true });
writeFileSync(resolve(ROOT, "docs/DEVNET-PROOF.md"), md);
console.log(`wrote docs/DEVNET-PROOF.md (${requests.length} requests, ${jobs.length} jobs)`);
