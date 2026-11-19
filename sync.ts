/**
 * Catalog sync from the command line.
 *
 *   npm run sync                 # sync if TCGCSV has a newer build than ours
 *   npm run sync -- --force      # sync even if nothing changed upstream
 *   npm run sync -- --full       # also re-download every set's product details
 *   npm run sync -- --sets 5     # only the 5 newest sets (quick dev run)
 *
 * Schedule this once a day (cron, GitHub Actions, your host's scheduler), or
 * leave AUTO_SYNC on and let the running server do it.
 */
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadEnvFile(file);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  // Imported after env is loaded so DATABASE_URL is honoured.
  const { runCatalogSync } = await import("../src/lib/catalog/sync");

  const limit = value("--sets");
  const result = await runCatalogSync({
    trigger: "cli",
    force: flag("--force"),
    full: flag("--full"),
    limitSets: limit ? Number(limit) : undefined,
    log: (line) => console.log(line),
  });

  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(
    `\n${result.status.toUpperCase()} in ${seconds}s — ${result.sets} sets, ${result.products} products, ` +
      `${result.prices} price updates, ${result.historyPoints} history points, ${result.requests} requests.` +
      (result.reason ? `\n${result.reason}` : ""),
  );
  if (result.errors.length) {
    console.log(`\n${result.errors.length} problem(s):\n - ${result.errors.slice(0, 10).join("\n - ")}`);
  }

  // Deliver any price-alert emails the sync queued.
  const { flushEmailQueue } = await import("../src/lib/email/outbox");
  await flushEmailQueue(500).catch(() => undefined);

  // Tell a running web server to drop its cached catalog pages.
  if (result.status === "ok" || result.status === "partial") {
    const { siteUrl } = await import("../src/lib/site-url");
    const appUrl = siteUrl();
    try {
      const { getInternalSecret } = await import("../src/lib/catalog/secret");
      const response = await fetch(`${appUrl}/api/revalidate`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET?.trim() || (await getInternalSecret())}` },
        signal: AbortSignal.timeout(5000),
      });
      console.log(
        response.ok
          ? `Refreshed cached pages on ${appUrl}.`
          : `Could not refresh cached pages on ${appUrl} (HTTP ${response.status}); they update on their own within the hour.`,
      );
    } catch {
      console.log(`No running site found at ${appUrl}; it will read the new data when it starts.`);
    }
  }

  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
