// Builds Anchor IDL JSON without the anchor CLI by running each program's
// `__anchor_private_print_idl` tests (the same thing `anchor idl build` does).
// Usage: node scripts/build-idl.mjs   (writes target/idl/*.json + target/types)
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const programs = ["zenith-oracle", "zenith-escrow"];
mkdirSync(`${root}/target/idl`, { recursive: true });

for (const p of programs) {
  const dir = `${root}/programs/${p}`;
  const out = execSync(
    "cargo test __anchor_private_print_idl --features idl-build -- --show-output --quiet",
    {
      cwd: dir,
      env: { ...process.env, ANCHOR_IDL_BUILD_PROGRAM_PATH: dir, ANCHOR_IDL_BUILD_RESOLUTION: "TRUE", ANCHOR_IDL_BUILD_SKIP_LINT: "TRUE", RUSTFLAGS: "-A warnings" },
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  ).toString();

  const blocks = [...out.matchAll(/--- IDL begin (\w+) ---\n([\s\S]*?)\n--- IDL end \1 ---/g)];
  let idl = null;
  let address = "";
  let errors = [];
  const events = [];
  const extraTypes = [];
  for (const [, kind, body] of blocks) {
    const json = JSON.parse(body);
    if (kind === "program") idl = json;
    else if (kind === "address") address = JSON.parse(json);
    else if (kind === "errors") errors = json;
    else if (kind === "event") {
      events.push(json.event);
      extraTypes.push(...json.types);
    }
  }
  if (!idl) throw new Error(`no program IDL for ${p}`);
  idl.address = address;
  if (errors.length) idl.errors = errors;
  if (events.length) idl.events = events;
  const types = idl.types ?? [];
  for (const t of extraTypes) if (!types.some((x) => x.name === t.name)) types.push(t);
  idl.types = types;

  // Like the anchor CLI: shorten `crate::Type` paths to `Type` when unambiguous.
  const full = [...types, ...(idl.accounts ?? []), ...(idl.events ?? [])].map((t) => t.name);
  const short = (n) => n.split("::").pop();
  const rename = new Map();
  for (const n of new Set(full)) {
    if ([...new Set(full)].filter((m) => short(m) === short(n)).length === 1) rename.set(n, short(n));
  }
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        o[k] = k === "name" && typeof x === "string" && rename.has(x) ? rename.get(x) : walk(x);
      }
      return o;
    }
    return v;
  };
  idl = walk(idl);

  const name = idl.metadata.name;
  writeFileSync(`${root}/target/idl/${name}.json`, JSON.stringify(idl, null, 2));
  console.log(`wrote target/idl/${name}.json (${idl.instructions.length} instructions)`);
}
