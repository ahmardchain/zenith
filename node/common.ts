// Shared Solana plumbing for the Zenith nodes, setup and demo scripts.
import "dotenv/config";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
const { AnchorProvider, BN, Program, Wallet, utils } = anchor;
type BN = InstanceType<typeof anchor.BN>;
type Program = InstanceType<typeof anchor.Program>;
const bs58 = utils.bytes.bs58;
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const KEYS_DIR = resolve(ROOT, "keys");

export const oracleIdl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/zenith_oracle.json"), "utf8")) as Idl;
export const escrowIdl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/zenith_escrow.json"), "utf8")) as Idl;
export const ORACLE_ID = new PublicKey(oracleIdl.address);
export const ESCROW_ID = new PublicKey(escrowIdl.address);

export const STATUS = { OPEN: 0, PROPOSED: 1, CHALLENGED: 2, FINALIZED: 3, CANCELLED: 4 } as const;
export const STATUS_NAME = ["OPEN", "PROPOSED", "CHALLENGED", "FINALIZED", "CANCELLED"];
export const JOB = { FUNDED: 0, SUBMITTED: 1, PAID: 2, REFUNDED: 3 } as const;
export const JOB_NAME = ["FUNDED", "SUBMITTED", "PAID", "REFUNDED"];

/** Byte offset of `status` inside a Request account (8-byte discriminator + fixed fields). */
export const REQUEST_STATUS_OFFSET = 8 + 32 + 8 + 32 + 8 + 8 + 8 + 8 + 8;
export const MAX_PROMPT_BYTES = 600;

export const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export function adminKeypair(): Keypair {
  const path = process.env.ADMIN_KEYPAIR ?? resolve(homedir(), ".config/solana/id.json");
  return loadKeypair(path);
}

/** Load keys/<name>.json, creating it on first use. */
export function roleKeypair(name: string): Keypair {
  const path = resolve(KEYS_DIR, `${name}.json`);
  if (!existsSync(path)) {
    mkdirSync(KEYS_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]));
  }
  return loadKeypair(path);
}

export function programs(signer: Keypair) {
  const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
  return {
    provider,
    oracle: new Program(oracleIdl, provider),
    escrow: new Program(escrowIdl, provider),
  };
}

export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], ORACLE_ID)[0];

export const requestPda = (requester: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("request"), requester.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    ORACLE_ID,
  )[0];

export const jobPda = (client: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("job"), client.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    ESCROW_ID,
  )[0];

export const vaultPda = (job: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), job.toBuffer()], ESCROW_ID)[0];

export const promptFor = (spec: string, deliverable: string) => `SPEC: ${spec}\nDELIVERABLE: ${deliverable}`;

export function newId(): BN {
  return new BN(Date.now()).muln(1000).addn(Math.floor(Math.random() * 1000));
}

export type RequestAccount = {
  requester: PublicKey;
  requestId: BN;
  subject: PublicKey;
  reward: BN;
  bond: BN;
  windowSecs: BN;
  juryTimeoutSecs: BN;
  createdAt: BN;
  status: number;
  proposer: PublicKey;
  proposedVerdict: number;
  proposedAt: BN;
  challenger: PublicKey;
  challengedVerdict: number;
  challengedAt: BN;
  votes: number[];
  finalVerdict: number;
  winner: PublicKey;
  finalizedAt: BN;
  bump: number;
  prompt: string;
  proposerReasoning: string;
  challengerReasoning: string;
};

export type JobAccount = {
  client: PublicKey;
  freelancer: PublicKey;
  mint: PublicKey;
  jobId: BN;
  amount: BN;
  deadline: BN;
  status: number;
  request: PublicKey;
  bump: number;
  vaultBump: number;
  spec: string;
};

export type ConfigAccount = {
  admin: PublicKey;
  bond: BN;
  windowSecs: BN;
  juryTimeoutSecs: BN;
  jurors: PublicKey[];
  bump: number;
};

/** Fetch oracle requests, optionally filtered by status (server-side memcmp). */
export async function fetchRequests(oracle: Program, status?: number) {
  const filters =
    status === undefined
      ? []
      : [{ memcmp: { offset: REQUEST_STATUS_OFFSET, bytes: bs58.encode(Uint8Array.of(status)) } }];
  const rows = await (oracle.account as any).request.all(filters);
  return rows as { publicKey: PublicKey; account: RequestAccount }[];
}

export async function fetchConfig(oracle: Program): Promise<ConfigAccount> {
  return (await (oracle.account as any).config.fetch(configPda())) as ConfigAccount;
}

export async function chainNow(): Promise<number> {
  const slot = await connection.getSlot();
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

export async function fund(from: Keypair, to: PublicKey, sol: number) {
  const have = await connection.getBalance(to);
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  if (have >= want) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: want - have }),
  );
  await AnchorProvider.prototype.sendAndConfirm.call(
    new AnchorProvider(connection, new Wallet(from), { commitment: "confirmed" }),
    tx,
  );
}

export const short = (k: PublicKey | string) => {
  const s = k.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

export const sol = (lamports: BN | number) =>
  (Number(lamports.toString()) / LAMPORTS_PER_SOL).toFixed(3).replace(/\.?0+$/, "");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(role: string, msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${t} [${role.padEnd(8)}] ${msg}`);
}
