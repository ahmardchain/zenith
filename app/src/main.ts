import "./polyfill";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Buffer } from "buffer";
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import deployment from "./deployment.json";
import oracleIdlJson from "../../target/idl/verdict_oracle.json";
import escrowIdlJson from "../../target/idl/verdict_escrow.json";

// ---------------------------------------------------------------- setup
const oracleIdl = { ...(oracleIdlJson as Idl), address: deployment.oracle } as Idl;
const escrowIdl = { ...(escrowIdlJson as Idl), address: deployment.escrow } as Idl;
const ORACLE_ID = new PublicKey(deployment.oracle);
const ESCROW_ID = new PublicKey(deployment.escrow);
const MINT = new PublicKey(deployment.mint);
const DEC = deployment.mintDecimals;
const SYM = deployment.mintSymbol;
const MAX_PROMPT = 600;
const NONE = PublicKey.default.toBase58();

const connection = new Connection(deployment.rpc, "confirmed");
const cluster = deployment.rpc.includes("devnet") ? "devnet" : deployment.rpc.includes("mainnet") ? "mainnet-beta" : "custom";
const explorer = (addr: string) =>
  `https://explorer.solana.com/address/${addr}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster === "custom" ? "custom&customUrl=" + encodeURIComponent(deployment.rpc) : cluster}`}`;

type WalletLike = {
  publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
};

let wallet: WalletLike | null = null;
let me: PublicKey | null = null;

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async () => { throw new Error("Connect a wallet first"); },
  signAllTransactions: async () => { throw new Error("Connect a wallet first"); },
};

function makePrograms() {
  const w = wallet && me
    ? { publicKey: me, signTransaction: wallet.signTransaction.bind(wallet), signAllTransactions: wallet.signAllTransactions.bind(wallet) }
    : readOnlyWallet;
  const provider = new AnchorProvider(connection, w as any, { commitment: "confirmed" });
  return { oracle: new Program(oracleIdl, provider), escrow: new Program(escrowIdl, provider) };
}
let P = makePrograms();

// ---------------------------------------------------------------- helpers
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const solFmt = (l: BN | number) => (Number(l.toString()) / LAMPORTS_PER_SOL).toFixed(3).replace(/\.?0+$/, "");
const tokFmt = (a: BN) => (Number(a.toString()) / 10 ** DEC).toLocaleString(undefined, { maximumFractionDigits: 2 });
const V = ["", "YES", "NO"];
const vClass = (v: number) => (v === 1 ? "v-yes" : v === 2 ? "v-no" : "");
const bytes = (s: string) => new TextEncoder().encode(s).length;
const prefixFor = (spec: string) => `SPEC: ${spec}\nDELIVERABLE: `;
const newId = () => new BN(Date.now()).muln(1000).addn(Math.floor(Math.random() * 1000));
const seed = (s: string) => new TextEncoder().encode(s);

const requestPda = (requester: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync([seed("request"), requester.toBuffer(), id.toArrayLike(Buffer, "le", 8)], ORACLE_ID)[0];
const jobPda = (client: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync([seed("job"), client.toBuffer(), id.toArrayLike(Buffer, "le", 8)], ESCROW_ID)[0];
const vaultPda = (job: PublicKey) => PublicKey.findProgramAddressSync([seed("vault"), job.toBuffer()], ESCROW_ID)[0];
const configPda = () => PublicKey.findProgramAddressSync([seed("config")], ORACLE_ID)[0];

function splitPrompt(p: string) {
  const m = p.match(/^SPEC:\s*([\s\S]*?)\nDELIVERABLE:\s*([\s\S]*)$/);
  return m ? { spec: m[1], deliverable: m[2] } : { spec: "", deliverable: p };
}

function toast(msg: string, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
}

function explainError(e: any): string {
  const m = String(e?.error?.errorMessage ?? e?.message ?? e);
  if (/User rejected/i.test(m)) return "Transaction cancelled in wallet.";
  if (/insufficient (funds|lamports)/i.test(m)) return "Not enough SOL in this wallet. Get devnet SOL at faucet.solana.com.";
  if (/could not find account|AccountNotInitialized/i.test(m)) return `This wallet has no ${SYM} account. Ask the organiser for test ${SYM}.`;
  return m.split("\n")[0].slice(0, 220);
}

async function tokenProgramFor(mint: PublicKey) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Token ${mint.toBase58()} not found on ${cluster}. Run npm run setup.`);
  return info.owner;
}

// ---------------------------------------------------------------- wallet
function injected(): WalletLike | null {
  const w = window as any;
  return w.phantom?.solana ?? w.solflare ?? w.backpack ?? w.solana ?? null;
}

$("#connect").addEventListener("click", async () => {
  wallet = injected();
  if (!wallet) {
    toast("No Solana wallet found. Install Phantom or Solflare, switch it to devnet, then reload.", true);
    return;
  }
  try {
    const res = await wallet.connect();
    me = new PublicKey((res?.publicKey ?? wallet.publicKey)!.toString());
    P = makePrograms();
    $("#connect").textContent = short(me);
    toast(`Connected ${short(me)} on ${cluster}.`);
    await refresh();
  } catch (e) {
    toast(explainError(e), true);
  }
});

// ---------------------------------------------------------------- tabs & counters
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll<HTMLElement>(".pane").forEach((p) => (p.hidden = p.dataset.pane !== tab.dataset.tab));
  }),
);
document.querySelectorAll(".sym").forEach((s) => (s.textContent = SYM));

function updateCounts() {
  const spec = $<HTMLTextAreaElement>("#hire [name=spec]");
  const specCount = $(".count[data-for=spec]");
  specCount.textContent = `${bytes(spec.value)} / 200`;
  specCount.classList.toggle("over", bytes(spec.value) > 200);

  const sel = $<HTMLSelectElement>("#deliver [name=job]");
  const job = jobs.find((j) => j.publicKey.toBase58() === sel.value);
  const d = $<HTMLTextAreaElement>("#deliver [name=deliverable]");
  const room = MAX_PROMPT - (job ? bytes(prefixFor(job.account.spec)) : 30);
  const dCount = $(".count[data-for=deliverable]");
  dCount.textContent = `${bytes(d.value)} / ${room}`;
  dCount.classList.toggle("over", bytes(d.value) > room);
  $("#spec-preview").textContent = job ? `Spec: ${job.account.spec}` : "";
}
document.addEventListener("input", updateCounts);

// ---------------------------------------------------------------- data
type Req = { publicKey: PublicKey; account: any };
let jobs: Req[] = [];
let requests: Req[] = [];
let chainOffset = 0; // chain time - local time, seconds
const lastStatus = new Map<string, number>();
const nowChain = () => Math.floor(Date.now() / 1000) + chainOffset;

async function refresh() {
  try {
    const [j, r, slot] = await Promise.all([
      (P.escrow.account as any).job.all(),
      (P.oracle.account as any).request.all(),
      connection.getSlot(),
    ]);
    jobs = j;
    requests = r;
    const bt = await connection.getBlockTime(slot);
    if (bt) chainOffset = bt - Math.floor(Date.now() / 1000);
    renderJobsSelect();
    render();
  } catch (e) {
    toast(`Could not load the docket: ${explainError(e)}`, true);
  }
}

function renderJobsSelect() {
  const sel = $<HTMLSelectElement>("#deliver [name=job]");
  const keep = sel.value;
  const mine = me ? jobs.filter((j) => j.account.freelancer.equals(me!) && j.account.status === 0) : [];
  sel.innerHTML = !me
    ? `<option value="">Connect a wallet to see your jobs</option>`
    : mine.length
      ? mine.map((j) => `<option value="${j.publicKey}">${esc(j.account.spec.slice(0, 48))} · ${tokFmt(j.account.amount)} ${SYM}</option>`).join("")
      : `<option value="">No open jobs for this wallet yet</option>`;
  if (mine.some((j) => j.publicKey.toBase58() === keep)) sel.value = keep;
  updateCounts();
}

function render() {
  const jobBySubject = new Map(jobs.map((j) => [j.publicKey.toBase58(), j]));
  const rows = [...requests].sort((a, b) => b.account.createdAt.toNumber() - a.account.createdAt.toNumber()).slice(0, 25);

  const finals = requests.filter((r) => r.account.status === 3);
  const disputes = requests.filter((r) => r.account.challenger.toBase58() !== NONE);
  const slashed = disputes.filter((r) => r.account.status === 3).reduce((s, r) => s + Number(r.account.bond.toString()), 0);
  $("#stats").textContent = `${requests.length} cases · ${finals.length} decided · ${disputes.length} disputed · ${solFmt(slashed)} SOL slashed`;

  const list = $("#cases");
  if (!rows.length) {
    list.innerHTML = `<li class="empty">No cases yet. Lock a payment under Hire, then deliver the work to open the first case.</li>`;
    return;
  }
  list.innerHTML = rows.map((r) => caseHtml(r, jobBySubject.get(r.account.subject.toBase58()))).join("");
  for (const r of rows) lastStatus.set(r.publicKey.toBase58(), r.account.status);
}

function caseHtml(r: Req, job?: Req) {
  const a = r.account;
  const key = r.publicKey.toBase58();
  const { spec, deliverable } = splitPrompt(a.prompt);
  const disputed = a.challenger.toBase58() !== NONE;
  const now = nowChain();
  const deadline = a.proposedAt.toNumber() + a.windowSecs.toNumber();
  const windowOpen = a.status === 1 && now < deadline;

  // Stamp
  const justLanded = lastStatus.has(key) && lastStatus.get(key) !== a.status && a.status >= 3;
  let stamp: string;
  if (a.status === 3) {
    stamp = `<div class="stamp ${a.finalVerdict === 1 ? "yes" : "no"}${justLanded ? " landed" : ""}">${V[a.finalVerdict]}<small>${disputed ? "by jury" : "unchallenged"}</small></div>`;
  } else if (a.status === 4) {
    stamp = `<div class="stamp pending">VOID<small>refunded</small></div>`;
  } else {
    stamp = `<div class="stamp pending">…<small>${["awaiting answer", "open to challenge", "jury voting"][a.status]}</small></div>`;
  }

  // Stages
  const labels = ["Asked", "Answered", "Challenge window", disputed ? "Jury" : "No dispute", "Verdict"];
  const current = a.status === 0 ? 1 : a.status === 1 ? 2 : a.status === 2 ? 3 : 5;
  const stages = labels
    .map((l, i) => `<li class="${i < current ? "done" : i === current ? "now" : ""}">${l}</li>`)
    .join("");

  // Fuse
  let fuse = "";
  if (windowOpen) {
    const left = deadline - now;
    const pct = Math.max(0, Math.min(100, (left / a.windowSecs.toNumber()) * 100));
    fuse = `<div class="fuse" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <p class="fuse-label">${left}s left to challenge · bond ${solFmt(a.bond)} SOL</p>`;
  } else if (a.status === 1) {
    fuse = `<p class="fuse-label">Challenge window closed. Ready to finalize.</p>`;
  }

  // Arguments
  let args = "";
  if (a.status >= 1) {
    args += `<dt>Solver</dt><dd><span class="${vClass(a.proposedVerdict)}">${V[a.proposedVerdict]}</span> · ${esc(a.proposerReasoning)} <a href="${explorer(a.proposer.toBase58())}" target="_blank" rel="noreferrer">${short(a.proposer)}</a></dd>`;
  }
  if (disputed) {
    args += `<dt>Challenger</dt><dd><span class="${vClass(a.challengedVerdict)}">${V[a.challengedVerdict]}</span> · ${esc(a.challengerReasoning)} <a href="${explorer(a.challenger.toBase58())}" target="_blank" rel="noreferrer">${short(a.challenger)}</a></dd>`;
  }

  const votes = disputed
    ? `<div class="votes">${(a.votes as number[]).map((v, i) => `<span class="vote">Juror ${i + 1}: <span class="${vClass(v)}">${v ? V[v] : a.status === 2 ? "voting…" : "not needed"}</span></span>`).join("")}</div>`
    : "";

  // Outcome
  let outcome = "";
  if (a.status === 3) {
    const loserBond = solFmt(a.bond);
    const who = a.winner.equals(a.proposer) ? "Solver" : "Challenger";
    outcome = disputed
      ? `${who} wins ${solFmt(a.reward)} SOL reward plus the other side's ${loserBond} SOL bond (slashed).`
      : `Solver earns ${solFmt(a.reward)} SOL reward and gets the bond back.`;
  }
  if (job) {
    const js = job.account.status;
    if (js === 2) outcome += ` Escrow paid ${tokFmt(job.account.amount)} ${SYM} to the freelancer.`;
    if (js === 3) outcome += ` Escrow refunded ${tokFmt(job.account.amount)} ${SYM} to the client.`;
  }

  // Actions
  const acts: string[] = [];
  if (windowOpen && me && !a.proposer.equals(me)) {
    const opposite = a.proposedVerdict === 1 ? 2 : 1;
    acts.push(`<button class="btn btn-small" data-act="challenge" data-req="${key}" data-v="${opposite}">Challenge with ${V[opposite]} (bond ${solFmt(a.bond)} SOL)</button>`);
  }
  if (a.status === 1 && !windowOpen && me) acts.push(`<button class="btn btn-small" data-act="finalize" data-req="${key}">Finalize</button>`);
  if (job && job.account.status === 1 && (a.status === 3 || a.status === 4) && me) {
    acts.push(`<button class="btn btn-small btn-ink" data-act="settle" data-job="${job.publicKey}">Settle escrow</button>`);
  }

  const money = job ? `<span class="money">${tokFmt(job.account.amount)} ${SYM}</span> in escrow · ` : "";
  return `<li class="case">
    <div><span class="case-no">Case ${short(key)}</span></div>
    <div class="case-meta">${money}reward ${solFmt(a.reward)} SOL · <a href="${explorer(key)}" target="_blank" rel="noreferrer">view on explorer</a></div>
    <p class="spec">${esc(spec || "Question")}</p>
    ${stamp}
    <p class="deliverable">${esc(deliverable)}</p>
    <ol class="stages">${stages}</ol>
    ${fuse}
    ${args ? `<dl class="argument">${args}</dl>` : ""}
    ${votes}
    ${outcome ? `<p class="outcome">${outcome}</p>` : ""}
    ${acts.length ? `<div class="actions">${acts.join("")}</div>` : ""}
  </li>`;
}

// ---------------------------------------------------------------- actions
async function withBusy(btn: HTMLButtonElement | null, label: string, fn: () => Promise<string>) {
  if (!me) return toast("Connect a wallet first.", true);
  if (btn) btn.disabled = true;
  toast(label);
  try {
    const sig = await fn();
    toast(`Done. Transaction ${short(sig)}.`);
    await refresh();
  } catch (e) {
    toast(explainError(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$("#hire").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target as HTMLFormElement);
  const btn = (ev.target as HTMLFormElement).querySelector("button");
  withBusy(btn, "Locking payment…", async () => {
    const freelancer = new PublicKey(String(f.get("freelancer")).trim());
    const spec = String(f.get("spec")).trim();
    if (bytes(spec) > 200) throw new Error("Spec is longer than 200 bytes.");
    const amount = new BN(Math.round(Number(f.get("amount")) * 10 ** DEC));
    const tokenProgram = await tokenProgramFor(MINT);
    const jobId = newId();
    const job = jobPda(me!, jobId);
    return P.escrow.methods
      .createJob(jobId, amount, freelancer, spec, new BN(nowChain() + 7 * 24 * 3600))
      .accountsPartial({
        client: me!,
        mint: MINT,
        clientToken: getAssociatedTokenAddressSync(MINT, me!, false, tokenProgram),
        job,
        vault: vaultPda(job),
        tokenProgram,
      })
      .rpc();
  });
});

$("#deliver").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target as HTMLFormElement);
  const btn = (ev.target as HTMLFormElement).querySelector("button");
  withBusy(btn, "Sending your work to the oracle…", async () => {
    const job = jobs.find((j) => j.publicKey.toBase58() === f.get("job"));
    if (!job) throw new Error("Pick a job first.");
    const prompt = prefixFor(job.account.spec) + String(f.get("deliverable")).trim();
    if (bytes(prompt) > MAX_PROMPT) throw new Error("Deliverable is too long for one on-chain case. Shorten it.");
    const reqId = newId();
    const request = requestPda(me!, reqId);
    const attach = await P.escrow.methods
      .submitWork()
      .accountsPartial({ freelancer: me!, job: job.publicKey, request })
      .instruction();
    return P.oracle.methods
      .createRequest(reqId, job.publicKey, prompt, new BN(Math.round(Number(f.get("reward") || 0) * LAMPORTS_PER_SOL)))
      .accountsPartial({ requester: me!, config: configPda(), request })
      .postInstructions([attach])
      .rpc();
  });
});

$("#cases").addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === "challenge") {
    const reason = window.prompt("Why is the solver wrong? (one sentence, shown on-chain)", "The deliverable does not meet the spec.");
    if (reason === null) return;
    const req = new PublicKey(btn.dataset.req!);
    withBusy(btn, "Posting challenge bond…", () =>
      P.oracle.methods
        .challenge(Number(btn.dataset.v), reason.slice(0, 180))
        .accountsPartial({ challenger: me!, request: req })
        .rpc(),
    );
  }

  if (act === "finalize") {
    const r = requests.find((x) => x.publicKey.toBase58() === btn.dataset.req)!;
    withBusy(btn, "Finalizing…", () =>
      P.oracle.methods.finalize().accountsPartial({ request: r.publicKey, proposer: r.account.proposer }).rpc(),
    );
  }

  if (act === "settle") {
    const j = jobs.find((x) => x.publicKey.toBase58() === btn.dataset.job)!;
    withBusy(btn, "Settling escrow…", async () => {
      const { createAssociatedTokenAccountIdempotentInstruction: ata } = await import("@solana/spl-token");
      const tp = await tokenProgramFor(j.account.mint);
      const clientToken = getAssociatedTokenAddressSync(j.account.mint, j.account.client, true, tp);
      const freelancerToken = getAssociatedTokenAddressSync(j.account.mint, j.account.freelancer, true, tp);
      return P.escrow.methods
        .settle()
        .accountsPartial({
          job: j.publicKey,
          request: j.account.request,
          mint: j.account.mint,
          vault: vaultPda(j.publicKey),
          clientToken,
          freelancerToken,
          tokenProgram: tp,
        })
        .preInstructions([
          ata(me!, clientToken, j.account.client, j.account.mint, tp),
          ata(me!, freelancerToken, j.account.freelancer, j.account.mint, tp),
        ])
        .rpc();
    });
  }
});

// ---------------------------------------------------------------- boot
$<HTMLAnchorElement>("#oracle-link").href = explorer(deployment.oracle);
$<HTMLAnchorElement>("#escrow-link").href = explorer(deployment.escrow);
$("#cluster").textContent = cluster;
updateCounts();
if (new URLSearchParams(location.search).has("preview")) {
  const { previewData } = await import("./preview");
  ({ jobs, requests } = previewData());
  $("#cluster").textContent = "preview data";
  renderJobsSelect();
  render();
} else {
  refresh();
  setInterval(refresh, 4000);
}
setInterval(() => requests.some((r) => r.account.status === 1) && render(), 1000);
