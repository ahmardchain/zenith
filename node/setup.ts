// One-shot devnet setup after deploying both programs:
//  - creates role keypairs in ./keys (solver, watcher, jurors, keeper, client, freelancer)
//  - funds them from your admin wallet
//  - initializes (or updates) the oracle config with the 3 juror keys
//  - creates a demo stablecoin "dUSDC" (6 decimals) and mints 1,000 to the client
//  - writes app/src/deployment.json for the web app
import anchor from "@coral-xyz/anchor";
const { BN } = anchor;
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ESCROW_ID,
  ORACLE_ID,
  ROOT,
  adminKeypair,
  configPda,
  connection,
  fund,
  log,
  programs,
  roleKeypair,
} from "./common.ts";

const admin = adminKeypair();
const roles = ["solver", "watcher", "juror1", "juror2", "juror3", "keeper", "client", "freelancer"] as const;
const keys = Object.fromEntries(roles.map((r) => [r, roleKeypair(r)])) as Record<(typeof roles)[number], ReturnType<typeof roleKeypair>>;

const bal = await connection.getBalance(admin.publicKey);
log("setup", `admin ${admin.publicKey} has ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL on ${connection.rpcEndpoint}`);
if (bal < 1.5 * LAMPORTS_PER_SOL) {
  log("setup", "need ~1.5 SOL. Get devnet SOL at https://faucet.solana.com then re-run.");
  process.exit(1);
}

for (const program of [ORACLE_ID, ESCROW_ID]) {
  const info = await connection.getAccountInfo(program);
  if (!info?.executable) {
    log("setup", `program ${program} is not deployed on this cluster. Run \`anchor deploy\` first.`);
    process.exit(1);
  }
}

const funding: Record<string, number> = {
  solver: 0.4, watcher: 0.4, keeper: 0.15, client: 0.15, freelancer: 0.15, juror1: 0.02, juror2: 0.02, juror3: 0.02,
};
for (const [role, amount] of Object.entries(funding)) {
  await fund(admin, keys[role as keyof typeof keys].publicKey, amount);
  log("setup", `funded ${role.padEnd(10)} ${keys[role as keyof typeof keys].publicKey} → ${amount} SOL`);
}

const { oracle } = programs(admin);
const params = {
  bond: new BN(Math.round(Number(process.env.BOND_SOL ?? 0.05) * LAMPORTS_PER_SOL)),
  windowSecs: new BN(Number(process.env.WINDOW_SECS ?? 60)),
  juryTimeoutSecs: new BN(Number(process.env.JURY_TIMEOUT_SECS ?? 600)),
  jurors: [keys.juror1.publicKey, keys.juror2.publicKey, keys.juror3.publicKey],
};
const existing = await connection.getAccountInfo(configPda());
if (existing) {
  await oracle.methods.updateConfig(params).accountsPartial({ admin: admin.publicKey, config: configPda() }).rpc();
  log("setup", "oracle config updated");
} else {
  await oracle.methods.initialize(params).accountsPartial({ admin: admin.publicKey, config: configPda() }).rpc();
  log("setup", "oracle config initialized");
}

const mintKp = roleKeypair("mint");
let mint = mintKp.publicKey;
if (!(await connection.getAccountInfo(mint))) {
  mint = await createMint(connection, admin, admin.publicKey, null, 6, mintKp);
  log("setup", `created dUSDC mint ${mint}`);
}
const clientAta = await getOrCreateAssociatedTokenAccount(connection, admin, mint, keys.client.publicKey);
await mintTo(connection, admin, mint, clientAta.address, admin, 1_000 * 10 ** 6);
log("setup", `minted 1,000 dUSDC to client ${keys.client.publicKey}`);

mkdirSync(resolve(ROOT, "app/src"), { recursive: true });
const deployment = {
  rpc: connection.rpcEndpoint,
  oracle: ORACLE_ID.toBase58(),
  escrow: ESCROW_ID.toBase58(),
  mint: mint.toBase58(),
  mintSymbol: "dUSDC",
  mintDecimals: 6,
};
writeFileSync(resolve(ROOT, "app/src/deployment.json"), JSON.stringify(deployment, null, 2));
log("setup", "wrote app/src/deployment.json — done. Next: `npm run nodes` (or `npm run demo`).");
