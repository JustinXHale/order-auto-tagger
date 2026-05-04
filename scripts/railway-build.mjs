/**
 * Railway/Nixpacks often omit service env vars during `npm run build`, but
 * `prisma generate` still needs DATABASE_URL to exist for schema validation.
 * Use a non-routable placeholder only when unset; runtime must use a real URL.
 */
import { execSync } from "node:child_process";

if (!process.env.DATABASE_URL?.trim()) {
  process.env.DATABASE_URL =
    "postgresql://prisma_build:prisma_build@127.0.0.1:5432/prisma_build";
}

execSync("npx prisma generate", { stdio: "inherit", env: process.env });
execSync("npx react-router build", { stdio: "inherit", env: process.env });
