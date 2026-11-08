// Send test dUSDC (and a little SOL) to any wallet, e.g. a judge's Phantom.
//   npm run faucet -- <wallet address> [dUSDC amount]
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, adminKeypair, connection, fund, log } from "./common.ts";

const [addr, amountArg] = process.argv.slice(2);
if (!addr) {
  console.log("usage: npm run faucet -- <wallet address> [dUSDC amount]");
  process.exit(1);
}
const to = new PublicKey(addr);
const amount = Number(amountArg ?? 500);
const deployment = JSON.parse(readFileSync(resolve(ROOT, "app/src/deployment.json"), "utf8"));
const mint = new PublicKey(deployment.mint);
const admin = adminKeypair();

const account = await getOrCreateAssociatedTokenAccount(connection, admin, mint, to);
await mintTo(connection, admin, mint, account.address, admin, Math.round(amount * 10 ** deployment.mintDecimals));
await fund(admin, to, 0.2);
log("faucet", `sent ${amount} dUSDC and topped up to 0.2 SOL → ${to}`);
