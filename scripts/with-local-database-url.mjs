/**
 * Runs a command with DATABASE_URL set (via ensure-local-database-url).
 * Use this for `npx prisma …` in shopify.web.toml so Prisma sees the variable.
 */
import { spawnSync } from "node:child_process";
import { ensureLocalDatabaseUrl } from "./ensure-local-database-url.mjs";

ensureLocalDatabaseUrl();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "usage: node scripts/with-local-database-url.mjs <command> [args...]",
  );
  process.exit(1);
}

const [command, ...commandArgs] = args;
const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);
