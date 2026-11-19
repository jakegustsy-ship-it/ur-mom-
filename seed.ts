/**
 * Demo data: a handful of traders, listings and trades at different stages,
 * so every screen has something to show while you develop.
 *
 *   npm run seed            # add demo data (needs a synced catalog: npm run sync)
 *   npm run seed -- --reset # remove demo data and add it again
 *   npm run seed -- --clear # only remove demo data
 *
 * All demo accounts are flagged is_demo = 1 and use the password printed at
 * the end. Do NOT run this against a production database.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadEnvFile(file);
}

const DEMO_PASSWORD = "trade-demo-2026";

type DemoUser = {
  username: string;
  email: string;
  displayName: string;
  role: "member" | "admin";
  location: string;
  bio: string;
  address: [string, string, string, string, string];
};

const USERS: DemoUser[] = [
  {
    username: "maya",
    email: "maya@example.com",
    displayName: "Maya R.",
    role: "member",
    location: "Portland, OR",
    bio: "Modern chase cards and alt arts. Always looking for Eeveelutions.",
    address: ["Maya R.", "100 Demo Street", "Portland", "OR", "97201"],
  },
  {
    username: "slabhunter",
    email: "dev@example.com",
    displayName: "Dev (Slab Hunter)",
    role: "member",
    location: "Austin, TX",
    bio: "Graded only. PSA and CGC, mostly 9s and 10s. Will add cash for the right slab.",
    address: ["Dev P.", "200 Sample Avenue", "Austin", "TX", "78701"],
  },
  {
    username: "sealedsam",
    email: "sam@example.com",
    displayName: "Sam K.",
    role: "member",
    location: "Columbus, OH",
    bio: "Sealed collector. Booster boxes and ETBs, stored flat and smoke-free.",
    address: ["Sam K.", "300 Placeholder Road", "Columbus", "OH", "43004"],
  },
  {
    username: "vintagevic",
    email: "vic@example.com",
    displayName: "Vic T.",
    role: "member",
    location: "Newark, NJ",
    bio: "WOTC era binder collection. Honest conditions, lots of played holos.",
    address: ["Vic T.", "400 Example Lane", "Newark", "NJ", "07101"],
  },
  {
    username: "hubstaff",
    email: "hub@example.com",
    displayName: "Hub Staff",
    role: "admin",
    location: "",
    bio: "",
    address: ["Hub Staff", "123 Example Street", "Your City", "ST", "00000"],
  },
];

async function main() {
  const args = process.argv.slice(2);
  if (process.env.NODE_ENV === "production" && !args.includes("--force")) {
    console.error("Refusing to seed demo data with NODE_ENV=production. Pass --force if you really mean it.");
    process.exit(1);
  }

  const { all, get, run, nowIso } = await import("../src/lib/db/client");
  const { hashPassword } = await import("../src/lib/auth/password");
  const { newId } = await import("../src/lib/ids");
  const { suggestedValueCents } = await import("../src/lib/conditions");
  const trades = await import("../src/lib/trades/service");

  const demoIds = (await all<{ id: string }>("SELECT id FROM users WHERE is_demo = 1")).map((row) => row.id);
  if (demoIds.length > 0) {
    if (!args.includes("--reset") && !args.includes("--clear")) {
      console.log("Demo data already exists. Use `npm run seed -- --reset` to rebuild it.");
      return;
    }
    const marks = demoIds.map(() => "?").join(",");
    const tradeFilter = `SELECT id FROM trades WHERE proposer_id IN (${marks}) OR recipient_id IN (${marks})`;
    const both = [...demoIds, ...demoIds];
    await run(`DELETE FROM payments WHERE trade_id IN (${tradeFilter})`, both);
    await run(`DELETE FROM reviews WHERE trade_id IN (${tradeFilter})`, both);
    await run(`DELETE FROM trade_events WHERE trade_id IN (${tradeFilter})`, both);
    await run(`DELETE FROM trade_items WHERE trade_id IN (${tradeFilter})`, both);
    await run(`DELETE FROM trade_parties WHERE trade_id IN (${tradeFilter})`, both);
    await run(`DELETE FROM trades WHERE proposer_id IN (${marks}) OR recipient_id IN (${marks})`, both);
    await run(`DELETE FROM wants WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM listing_photos WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM listings WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM notifications WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM emails WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM auth_tokens WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM sessions WHERE user_id IN (${marks})`, demoIds);
    await run(`DELETE FROM users WHERE id IN (${marks})`, demoIds);
    console.log(`Removed demo data for ${demoIds.length} accounts.`);
  }
  if (args.includes("--clear")) {
    if (demoIds.length === 0) console.log("No demo data to remove.");
    return;
  }

  const catalog = await get<{ n: number }>("SELECT COUNT(*) AS n FROM products");
  if (!catalog?.n) {
    console.error("The catalog is empty. Run `npm run sync` first, then seed.");
    process.exit(1);
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ids: Record<string, string> = {};
  for (const user of USERS) {
    const clash = await get("SELECT 1 AS x FROM users WHERE email = ? OR username = ?", [user.email, user.username]);
    if (clash) {
      console.error(`A real account already uses ${user.email} or @${user.username}; not seeding over it.`);
      process.exit(1);
    }
    const id = newId("usr");
    ids[user.username] = id;
    await run(
      `INSERT INTO users (id, email, username, display_name, password_hash, role, bio, location, ship_name, ship_line1,
                          ship_city, ship_region, ship_postal, ship_country, is_demo, email_verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'United States', 1, ?, ?)`,
      [
        id, user.email, user.username, user.displayName, passwordHash, user.role, user.bio, user.location,
        user.address[0], user.address[1], user.address[2], user.address[3], user.address[4], nowIso(), nowIso(),
      ],
    );
  }

  // ── Listings ──────────────────────────────────────────────────────────────
  type Found = { id: number; name: string; kind: "card" | "sealed"; market_price: number | null; primary_printing: string | null };
  const find = async (terms: string, kind: "card" | "sealed"): Promise<Found | undefined> => {
    const tokens = terms.toLowerCase().split(" ").filter(Boolean);
    // Cards: the most valuable print that matches. Sealed: the plainest match
    // ("151 Elite Trainer Box", not the case of ten or a store-exclusive bundle).
    return get<Found>(
      `SELECT id, name, kind, market_price, primary_printing FROM products
        WHERE kind = ? AND market_price IS NOT NULL AND image_url IS NOT NULL
          AND (sealed_type IS NULL OR sealed_type NOT IN ('Case', 'Display'))
          AND ${tokens.map(() => "search_text LIKE ?").join(" AND ")}
        ORDER BY CASE WHEN kind = 'sealed' THEN LENGTH(name) ELSE 0 END, market_price DESC LIMIT 1`,
      [kind, ...tokens.map((token) => `%${token}%`)],
    );
  };

  type Spec =
    | { owner: string; terms: string; kind: "raw"; condition: string; notes?: string }
    | { owner: string; terms: string; kind: "sealed"; condition: string; notes?: string }
    | { owner: string; terms: string; kind: "graded"; grader: string; grade: string; multiple: number; notes?: string };

  const listingIds: Record<string, string> = {};
  let certSeed = 71234001;
  const list = async (key: string, spec: Spec): Promise<string | undefined> => {
    const product = await find(spec.terms, spec.kind === "sealed" ? "sealed" : "card");
    if (!product) {
      console.warn(`  (skipped "${spec.terms}" — not in the catalog)`);
      return undefined;
    }
    const market = product.market_price ?? 0;
    const value =
      spec.kind === "graded"
        ? Math.round(market * spec.multiple) * 100
        : (suggestedValueCents(spec.kind, spec.condition, market) ?? Math.round(market * 100));
    const id = newId("lst");
    const now = nowIso();
    await run(
      `INSERT INTO listings (id, user_id, product_id, kind, printing, condition, grader, grade, cert_number,
                             value_cents, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        ids[spec.owner],
        product.id,
        spec.kind,
        spec.kind === "sealed" ? null : product.primary_printing,
        spec.kind === "graded" ? null : spec.condition,
        spec.kind === "graded" ? spec.grader : null,
        spec.kind === "graded" ? spec.grade : null,
        spec.kind === "graded" ? String(certSeed++) : null,
        Math.max(value, 100),
        spec.notes ?? "",
        now,
        now,
      ],
    );
    listingIds[key] = id;
    return id;
  };

  const SPECS: [string, Spec][] = [
    // Maya: modern raw
    ["maya_zard", { owner: "maya", terms: "charizard ex 199/165", kind: "raw", condition: "NM", notes: "Pack fresh, straight into a sleeve. Centering slightly left." }],
    ["maya_umbreon", { owner: "maya", terms: "umbreon vmax 215/203", kind: "raw", condition: "LP", notes: "Light whitening on two back corners." }],
    ["maya_giratina", { owner: "maya", terms: "giratina v 186/196", kind: "raw", condition: "NM" }],
    ["maya_pika", { owner: "maya", terms: "pikachu 173/165", kind: "raw", condition: "NM" }],
    ["maya_mew", { owner: "maya", terms: "mew ex 232/091", kind: "raw", condition: "NM" }],
    ["maya_gengar", { owner: "maya", terms: "gengar vmax 271/264", kind: "raw", condition: "NM" }],
    // Dev: graded
    ["dev_lugia", { owner: "slabhunter", terms: "lugia v 186/195", kind: "graded", grader: "PSA", grade: "10", multiple: 2.4, notes: "Fresh slab, no scratches on the case." }],
    ["dev_rayquaza", { owner: "slabhunter", terms: "rayquaza vmax 218/203", kind: "graded", grader: "CGC", grade: "9.5", multiple: 1.5 }],
    ["dev_blastoise", { owner: "slabhunter", terms: "blastoise ex 200/165", kind: "graded", grader: "PSA", grade: "9", multiple: 1.3 }],
    ["dev_moonbreon", { owner: "slabhunter", terms: "umbreon v 189/203", kind: "graded", grader: "PSA", grade: "10", multiple: 2.2 }],
    ["dev_venusaur", { owner: "slabhunter", terms: "venusaur ex 198/165", kind: "graded", grader: "BGS", grade: "9.5", multiple: 1.6 }],
    // Sam: sealed
    ["sam_151etb", { owner: "sealedsam", terms: "151 elite trainer box", kind: "sealed", condition: "MINT" }],
    ["sam_bundle", { owner: "sealedsam", terms: "151 booster bundle", kind: "sealed", condition: "MINT" }],
    ["sam_evs", { owner: "sealedsam", terms: "evolving skies booster box", kind: "sealed", condition: "SHELF", notes: "Small dent on one corner, wrap intact." }],
    ["sam_cz", { owner: "sealedsam", terms: "crown zenith elite trainer box", kind: "sealed", condition: "MINT" }],
    ["sam_lost", { owner: "sealedsam", terms: "lost origin booster box", kind: "sealed", condition: "MINT" }],
    // Vic: vintage raw
    ["vic_blastoise", { owner: "vintagevic", terms: "blastoise 002/102 base set", kind: "raw", condition: "MP", notes: "Holo scratching visible at an angle, no creases." }],
    ["vic_venusaur", { owner: "vintagevic", terms: "venusaur 015/102 base set", kind: "raw", condition: "LP" }],
    ["vic_lugia", { owner: "vintagevic", terms: "lugia 9/111 neo genesis", kind: "raw", condition: "MP" }],
    ["vic_darkzard", { owner: "vintagevic", terms: "dark charizard 4/82", kind: "raw", condition: "HP", notes: "Binder dent top right. Priced accordingly." }],
    ["vic_gyarados", { owner: "vintagevic", terms: "gyarados 006/102 base set", kind: "raw", condition: "LP" }],
    ["vic_alakazam", { owner: "vintagevic", terms: "alakazam 001/102 base set", kind: "raw", condition: "LP" }],
  ];
  for (const [key, spec] of SPECS) await list(key, spec);
  console.log(`Created ${Object.keys(listingIds).length} listings for ${USERS.length - 1} traders.`);

  // ── Wantlists ─────────────────────────────────────────────────────────────
  const want = async (owner: string, terms: string, kind: "card" | "sealed") => {
    const product = await find(terms, kind);
    if (!product) return;
    await run(
      "INSERT INTO wants (id, user_id, product_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, product_id) DO NOTHING",
      [newId("wnt"), ids[owner], product.id, nowIso()],
    );
  };
  await want("maya", "umbreon v 189/203", "card");
  await want("maya", "evolving skies booster box", "sealed");
  await want("slabhunter", "charizard ex 199/165", "card");
  await want("sealedsam", "151 booster bundle", "sealed");
  await want("vintagevic", "lugia v 186/195", "card");

  // ── Trades at different stages ────────────────────────────────────────────
  const hub = ids.hubstaff;
  const has = (...keys: string[]) => keys.every((key) => listingIds[key]);
  let tracking = 9400100000000000;
  const nextTracking = () => String(tracking++);

  /** Run a trade all the way from offer to both packages inspected. */
  const toInspection = async (a: string, give: string[], b: string, get_: string[], cash: number, message: string) => {
    const { tradeId } = await trades.proposeTrade({
      proposerId: ids[a],
      recipientId: ids[b],
      giveListingIds: give.map((key) => listingIds[key]),
      getListingIds: get_.map((key) => listingIds[key]),
      cashFromProposerCents: cash,
      message,
    });
    await trades.acceptTrade(tradeId, ids[b]);
    await trades.markShippedToHub(tradeId, ids[a], "USPS", nextTracking());
    await trades.markShippedToHub(tradeId, ids[b], "UPS", nextTracking());
    await trades.receivePackage(tradeId, ids[a], hub);
    await trades.receivePackage(tradeId, ids[b], hub);
    return tradeId;
  };
  const itemsOf = (tradeId: string) =>
    all<{ id: string; listing_id: string }>("SELECT id, listing_id FROM trade_items WHERE trade_id = ?", [tradeId]);
  const finish = async (tradeId: string, a: string, b: string) => {
    await trades.setPayment(tradeId, ids[a], hub, "paid");
    await trades.setPayment(tradeId, ids[b], hub, "paid");
    await trades.shipFromHub(tradeId, ids[a], hub, "USPS", nextTracking());
    await trades.shipFromHub(tradeId, ids[b], hub, "USPS", nextTracking());
    await trades.confirmDelivery(tradeId, ids[a], ids[a]);
    await trades.confirmDelivery(tradeId, ids[b], ids[b]);
  };

  let created = 0;

  // 1. Completed cleanly, with a cash top-up: Maya ⇄ Vic
  if (has("maya_pika", "vic_gyarados")) {
    const id = await toInspection("maya", ["maya_pika"], "vintagevic", ["vic_gyarados"], 4000, "Been after a Base Gyarados for the binder. Pikachu plus $40?");
    for (const item of await itemsOf(id)) await trades.inspectItem(item.id, hub, { status: "passed" });
    await finish(id, "maya", "vintagevic");
    await trades.leaveReview(id, ids.maya, 5, "Card was exactly as described and Vic shipped the same day.");
    await trades.leaveReview(id, ids.vintagevic, 5, "Smooth trade, great communication.");
    created++;
  }

  // 2. Completed after a condition mismatch was accepted: Dev ⇄ Sam
  if (has("dev_venusaur", "sam_bundle")) {
    const id = await toInspection("slabhunter", ["dev_venusaur"], "sealedsam", ["sam_bundle"], 2500, "Venusaur slab plus $25 for the 151 bundle?");
    for (const item of await itemsOf(id)) {
      if (item.listing_id === listingIds.sam_bundle) {
        await trades.inspectItem(item.id, hub, {
          status: "condition_mismatch",
          verifiedCondition: "SHELF",
          notes: "Factory seal intact. One corner is dinged and the wrap is scuffed on the back.",
        });
      } else {
        await trades.inspectItem(item.id, hub, { status: "passed" });
      }
    }
    await trades.resolveIssue(id, ids.slabhunter, "accept");
    await finish(id, "slabhunter", "sealedsam");
    await trades.leaveReview(id, ids.slabhunter, 4, "Box had a corner ding that wasn't mentioned, but the hub caught it and I was happy to go ahead.");
    await trades.leaveReview(id, ids.sealedsam, 5, "Beautiful slab. Easy trade.");
    created++;
  }

  // 3. Both packages at the hub, waiting for inspection: Maya ⇄ Sam
  if (has("maya_giratina", "sam_lost")) {
    await toInspection("maya", ["maya_giratina"], "sealedsam", ["sam_lost"], 0, "Giratina alt art for the Lost Origin box? Fitting.");
    created++;
  }

  // 4. Accepted, waiting for both to ship: Vic ⇄ Dev (Dev adds cash)
  if (has("vic_darkzard", "dev_blastoise")) {
    const { tradeId } = await trades.proposeTrade({
      proposerId: ids.vintagevic,
      recipientId: ids.slabhunter,
      giveListingIds: [listingIds.vic_darkzard],
      getListingIds: [listingIds.dev_blastoise],
      cashFromProposerCents: -5000,
      message: "Dark Charizard for the Blastoise slab if you can add $50 to even it out?",
    });
    await trades.acceptTrade(tradeId, ids.slabhunter);
    created++;
  }

  // 5. An offer waiting for Maya's answer: Dev → Maya, two cards for one slab
  if (has("dev_rayquaza", "maya_gengar", "maya_mew")) {
    await trades.proposeTrade({
      proposerId: ids.slabhunter,
      recipientId: ids.maya,
      giveListingIds: [listingIds.dev_rayquaza],
      getListingIds: [listingIds.maya_gengar, listingIds.maya_mew],
      cashFromProposerCents: 0,
      message: "Rayquaza CGC 9.5 for your Gengar and Mew? Values line up almost to the dollar.",
    });
    created++;
  }

  // On a hosted database the site is on the internet, and a hub staff login
  // with a password written in this file would open the hub console to anyone
  // who reads it. Lock that one account; your own ADMIN_EMAILS account runs the hub.
  const { isHostedDatabase } = await import("../src/lib/db/client");
  const lockHub = isHostedDatabase();
  if (lockHub) {
    const { randomBytes } = await import("node:crypto");
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [
      await hashPassword(randomBytes(32).toString("base64url")),
      ids.hubstaff,
    ]);
  }

  console.log(`Created ${created} trades (2 completed, 1 at inspection, 1 awaiting shipment, 1 open offer).`);
  console.log("\nDemo logins (password for all: " + DEMO_PASSWORD + ")");
  for (const user of USERS) {
    if (user.role === "admin" && lockHub) {
      console.log(`  hub staff  ${user.email.padEnd(18)} (sign-in disabled on a hosted database; use an ADMIN_EMAILS account)`);
      continue;
    }
    console.log(`  ${user.role === "admin" ? "hub staff" : "trader   "}  ${user.email.padEnd(18)} @${user.username}`);
  }
  console.log("\nRemove all of this with: npm run seed -- --clear");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
