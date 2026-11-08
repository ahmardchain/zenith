// After `anchor keys sync`, copy the oracle's program ID into the escrow's
// `oracle_program` module and rebuild the IDLs.  Usage: npm run sync-ids
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const oracleSrc = readFileSync(`${root}/programs/zenith-oracle/src/lib.rs`, "utf8");
const oracleId = oracleSrc.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/)?.[1];
if (!oracleId) throw new Error("could not find oracle declare_id");

const escrowPath = `${root}/programs/zenith-escrow/src/lib.rs`;
const escrowSrc = readFileSync(escrowPath, "utf8");
const pattern = /(pub const ORACLE_PROGRAM_ID: Pubkey =\s*anchor_lang::pubkey!\(")[^"]+("\))/;
if (!pattern.test(escrowSrc)) throw new Error("could not find ORACLE_PROGRAM_ID in escrow lib.rs");
const updated = escrowSrc.replace(pattern, `$1${oracleId}$2`);
writeFileSync(escrowPath, updated);
console.log(`escrow now trusts oracle program ${oracleId}`);
execSync("node scripts/build-idl.mjs", { cwd: root, stdio: "inherit" });
