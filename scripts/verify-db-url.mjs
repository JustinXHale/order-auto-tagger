/**
 * Fail fast with a clear log line if DATABASE_URL is missing at container runtime.
 * Does not print the URL (secret).
 */
const has = Boolean(process.env.DATABASE_URL?.trim());
// #region agent log
console.log(
  JSON.stringify({
    sessionId: "3680cb",
    hypothesisId: "H-runtime-db-url",
    message: "DATABASE_URL presence at setup",
    data: { present: has },
    timestamp: Date.now(),
  }),
);
// #endregion
if (!has) {
  console.error(
    "[order-auto-tagger] DATABASE_URL is missing. In Railway: order-auto-tagger → Variables → add DATABASE_URL (reference your Postgres service), then redeploy.",
  );
  process.exit(1);
}
