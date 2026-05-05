/**
 * Runs a command with DATABASE_URL set (via ensure-local-database-url).
 * Use this for `npx prisma …` in shopify.web.toml so Prisma sees the variable.
 *
 * Loads .env manually first so DATABASE_URL from .env takes priority over
 * the local fallback in ensure-local-database-url.mjs.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalDatabaseUrl } from "./ensure-local-database-url.mjs";

// Load .env before ensure runs so a real DATABASE_URL is not overridden
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envContent = readFileSync(resolve(__dirname, "../.env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // no .env file — that's fine
}

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
