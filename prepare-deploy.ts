/**
 * Runs before `next build` on Vercel (vercel.json → `npm run vercel-build`).
 *
 * Brings the hosted database up to date so every deploy, the first one
 * included, has the catalog, today's prices and the last 30 days of price
 * history without anyone running a command:
 *
 *   1. npm run sync                      a quick no-op when TCGCSV has nothing new
 *   2. npm run backfill -- --recent 30   only days still missing (normally none)
 *   3. demo data                         added while DEMO_DATA=1, removed otherwise
 *   4. npm run admins                    existing ADMIN_EMAILS accounts become hub staff
 *
 * Problems with the price source are reported in the build log but never stop
 * the deploy; the daily cron job catches up. A missing database does stop it,
 * with a message saying how to connect one. A missing CRON_SECRET only gets a
 * warning, since the site works without it but its prices stop updating.
 */
import { spawnSync } from "node:child_process";

function step(title: string, npmArgs: string[], timeoutMinutes: number): boolean {
  console.log(`\n=== ${title}`);
  const result = spawnSync("npm", ["run", ...npmArgs], {
    stdio: "inherit",
    timeout: timeoutMinutes * 60_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `exit code ${result.status}`;
    console.log(`=== ${title} did not complete (${why}); the deploy continues and the daily update will catch up.`);
    return false;
  }
  return true;
}

function main() {
  const url = process.env.DATABASE_URL?.trim() || process.env.TURSO_DATABASE_URL?.trim() || "";
  if (!url || url.startsWith("file:")) {
    if (process.env.VERCEL && !url) {
      console.error(
        "\nNo database is connected to this Vercel project.\n" +
          "Add one under Storage (Turso Cloud), or set DATABASE_URL and DATABASE_AUTH_TOKEN in\n" +
          "Settings > Environment Variables, then redeploy. Vercel does not keep files between\n" +
          "requests, so the site cannot use a local database file there.\n",
      );
      process.exit(1);
    }
    console.log("No hosted database configured; skipping data preparation.");
    return;
  }

  const synced = step("Updating the catalog and prices", ["sync"], 15);
  if (synced) step("Importing any missing price history (last 30 days)", ["backfill", "--", "--recent", "30"], 20);

  if (process.env.DEMO_DATA?.trim() === "1") {
    if (synced) step("Adding demo traders and trades (DEMO_DATA=1)", ["seed", "--", "--force"], 5);
  } else {
    step("Removing demo data if present (DEMO_DATA is not 1)", ["seed", "--", "--clear", "--force"], 5);
  }

  if (process.env.ADMIN_EMAILS?.trim()) step("Making ADMIN_EMAILS accounts hub staff", ["admins"], 2);

  if (process.env.VERCEL && !process.env.CRON_SECRET?.trim()) {
    console.log(
      "\nWarning: CRON_SECRET is not set, so Vercel's daily price update will be refused and prices\n" +
        "will stop updating. Add it under Settings > Environment Variables (a random string of\n" +
        "letters and numbers, at least 32 characters), then redeploy.",
    );
  }
}

main();
