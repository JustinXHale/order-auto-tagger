/**
 * `shopify app dev` runs Prisma before a shell profile loads `.env` in some setups.
 * If DATABASE_URL is missing, use a local Postgres default (Docker one-liner in README).
 *
 * Import `ensureLocalDatabaseUrl` and call it before spawning Prisma so child processes
 * inherit DATABASE_URL (setting env only inside a prior `node ensure-…` process does not).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export function ensureLocalDatabaseUrl() {
  if (!process.env.DATABASE_URL?.trim()) {
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@127.0.0.1:5432/order_auto_tagger";
    console.warn(
      "[order-auto-tagger] DATABASE_URL not set; using default 127.0.0.1:5432/order_auto_tagger (postgres/postgres). Set DATABASE_URL in .env or run: docker run -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=order_auto_tagger -p 5432:5432 -d postgres:16",
    );
  }
}

const __filename = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  ensureLocalDatabaseUrl();
}
