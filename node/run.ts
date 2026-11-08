// npm run nodes                 -> all roles
// npm run nodes -- solver jury  -> only some roles
// SOLVER_MODE=naive npm run nodes -- solver   -> a solver that falls for prompt injection
import { startNodes, type Role } from "./nodes.ts";

const all: Role[] = ["solver", "watcher", "jury", "keeper"];
const picked = process.argv.slice(2).filter((a): a is Role => (all as string[]).includes(a));
startNodes(picked.length ? picked : all);
