/**
 * One-time price history backfill from TCGCSV's daily archives.
 *
 *   npm run backfill                       # the 30 days before your oldest history
 *   npm run backfill -- --days 90          # ...or more (archives start 2024-02-08)
 *   npm run backfill -- --from 2026-01-01 --to 2026-03-31
 *   npm run backfill -- --recent 30        # any of the last 30 days that are still missing
 *                                          # (what each Vercel build runs; usually nothing to do)
 *
 * TCGCSV publishes one immutable archive per day (~4 MB). Their rules: a
 * one-time download of history is fine, but never download the same day
 * twice. So each archive is kept in data/archives/ after it's fetched, and
 * imported days are recorded in the database. Delete data/archives/ only if
 * you're sure you won't import those days again.
 *
 * Needs the catalog synced first (`npm run sync`), since only products in the
 * catalog are imported.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadEnvFile(file);
}

const USER_AGENT = "Handoff/0.1.0";
const FIRST_ARCHIVE_DAY = "2024-02-08";
const POKEMON_CATEGORY = 3;
const ARCHIVE_DIR = path.resolve("data/archives");
const BATCH = 500;

type PriceRow = { productId: number; marketPrice: number | null; lowPrice: number | null; subTypeName: string };

function dayAdd(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sevenZip(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const binary = (require("7zip-bin") as { path7za: string }).path7za;
  if (!(statSync(binary).mode & 0o111)) chmodSync(binary, 0o755);
  return binary;
}

async function download(day: string): Promise<string | null> {
  const file = path.join(ARCHIVE_DIR, `prices-${day}.ppmd.7z`);
  if (existsSync(file) && statSync(file).size > 0) return file;
  const response = await fetch(`https://tcgcsv.com/archive/tcgplayer/prices-${day}.ppmd.7z`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Archive ${day}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

function readDay(archive: string, day: string): PriceRow[] {
  const work = path.join(ARCHIVE_DIR, `.extract-${day}`);
  rmSync(work, { recursive: true, force: true });
  try {
    execFileSync(sevenZip(), ["x", "-y", `-o${work}`, archive, `${day}/${POKEMON_CATEGORY}/*`, "-r"], { stdio: "ignore" });
    const root = path.join(work, day, String(POKEMON_CATEGORY));
    if (!existsSync(root)) return [];
    const rows: PriceRow[] = [];
    for (const group of readdirSync(root)) {
      const file = path.join(root, group, "prices");
      if (!existsSync(file)) continue;
      try {
        const body = JSON.parse(readFileSync(file, "utf8")) as { results?: PriceRow[] };
        rows.push(...(body.results ?? []));
      } catch {
        // A malformed file only costs that set for that day.
      }
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const LOCK_KEY = "backfill_lock";
const LOCK_STALE_MS = 30 * 60 * 1000;

async function main() {
  const { all, batch, get, run } = await import("../src/lib/db/client");
  mkdirSync(ARCHIVE_DIR, { recursive: true });

  const catalog = new Set((await all<{ id: number }>("SELECT id FROM products")).map((row) => row.id));
  if (catalog.size === 0) {
    console.error("The catalog is empty. Run `npm run sync` first.");
    process.exit(1);
  }

  // Which days to import.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = dayAdd(today, -1);
  let from: string;
  let to: string;
  const recent = arg("--recent");
  if (recent) {
    // Days from the first live sync onwards are recorded by the sync itself,
    // so only the days before it are ever fetched from the archives.
    const firstSynced = (
      await get<{ day: string | null }>(
        "SELECT MIN(substr(source_updated_at, 1, 10)) AS day FROM sync_runs WHERE status IN ('ok', 'partial') AND source_updated_at IS NOT NULL",
      )
    )?.day;
    to = firstSynced ? dayAdd(firstSynced, -1) : yesterday;
    if (to > yesterday) to = yesterday;
    from = dayAdd(today, -Math.max(1, Math.min(Number(recent) || 30, 1000)));
  } else {
    const oldest = (await get<{ day: string | null }>("SELECT MIN(day) AS day FROM price_history"))?.day;
    to = arg("--to") ?? (oldest ? dayAdd(oldest, -1) : yesterday);
    const days = Number(arg("--days") ?? 30);
    from = arg("--from") ?? dayAdd(to, -(Math.max(1, Math.min(days, 1000)) - 1));
  }
  if (from < FIRST_ARCHIVE_DAY) from = FIRST_ARCHIVE_DAY;
  if (from > to) {
    console.log(`Nothing to do: ${from} is after ${to}.`);
    return;
  }

  // One import at a time (two deploys building at once would otherwise
  // download the same archives twice).
  const lockValue = new Date().toISOString();
  const claimed = await run(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE kv.value < ?`,
    [LOCK_KEY, lockValue, new Date(Date.now() - LOCK_STALE_MS).toISOString()],
  );
  if (claimed === 0) {
    console.log("Another history import is running; skipping.");
    return;
  }
  try {
    await importDays(from, to, catalog, { all, batch, run });
  } finally {
    await run("DELETE FROM kv WHERE key = ? AND value = ?", [LOCK_KEY, lockValue]);
  }
}

type Db = Pick<typeof import("../src/lib/db/client"), "all" | "batch" | "run">;

async function importDays(from: string, to: string, catalog: Set<number>, { all, batch, run }: Db) {
  const imported = new Set(
    (await all<{ key: string }>("SELECT key FROM kv WHERE key LIKE 'archive_imported:%'")).map((row) => row.key.slice("archive_imported:".length)),
  );
  const wanted: string[] = [];
  for (let day = from; day <= to; day = dayAdd(day, 1)) if (!imported.has(day)) wanted.push(day);
  console.log(`Backfilling ${wanted.length} day(s) from ${from} to ${to} (${imported.size} already imported).`);
  if (wanted.length === 0) return;

  // Last known value per product/printing before the first day, so only changes are stored.
  const last = new Map<string, number>();
  for (const row of await all<{ product_id: number; printing: string; market: number | null }>(
    `SELECT h.product_id, h.printing, h.market FROM price_history h
      WHERE h.day = (SELECT MAX(day) FROM price_history h2
                      WHERE h2.product_id = h.product_id AND h2.printing = h.printing AND h2.day < ?)`,
    [wanted[0]],
  )) {
    if (row.market != null) last.set(`${row.product_id}|${row.printing}`, row.market);
  }

  let totalPoints = 0;
  for (const [index, day] of wanted.entries()) {
    const started = Date.now();
    const archive = await download(day);
    if (!archive) {
      console.log(`[${index + 1}/${wanted.length}] ${day}: no archive published, skipped.`);
      continue;
    }
    const rows = readDay(archive, day);
    const statements: { sql: string; args: (string | number | null)[] }[] = [];
    for (const row of rows) {
      if (!catalog.has(row.productId) || row.marketPrice == null) continue;
      const printing = row.subTypeName?.trim() || "Normal";
      const key = `${row.productId}|${printing}`;
      if (last.get(key) === row.marketPrice) continue;
      last.set(key, row.marketPrice);
      statements.push({
        sql: `INSERT INTO price_history (product_id, printing, day, market, low) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(product_id, printing, day) DO NOTHING`,
        args: [row.productId, printing, day, row.marketPrice, row.lowPrice ?? null],
      });
    }
    for (let i = 0; i < statements.length; i += BATCH) await batch(statements.slice(i, i + BATCH));
    await run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [`archive_imported:${day}`, String(statements.length)]);
    totalPoints += statements.length;
    console.log(
      `[${index + 1}/${wanted.length}] ${day}: ${rows.length.toLocaleString("en-US")} prices, ${statements.length.toLocaleString("en-US")} changes stored (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    // Be gentle with a free service.
    if (index < wanted.length - 1) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`\nDone. ${totalPoints.toLocaleString("en-US")} history points added.`);

  // Tell a running site to refresh its cached charts and market pages.
  const { siteUrl } = await import("../src/lib/site-url");
  const appUrl = siteUrl();
  try {
    const { getInternalSecret } = await import("../src/lib/catalog/secret");
    const response = await fetch(`${appUrl}/api/revalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CRON_SECRET?.trim() || (await getInternalSecret())}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) console.log(`Refreshed cached pages on ${appUrl}.`);
  } catch {
    // No running site; it picks up the history when it starts.
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
