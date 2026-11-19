# Handoff

Verified trading for Pokémon TCG collectors. Two traders agree on a swap, both ship to a hub, staff authenticate and condition-check every item, then each side receives what they agreed to. No meetups.

"Handoff" is a placeholder name. Change it in `src/config/site.ts` and it changes everywhere.

## What works today

**Catalog and market data**
- Every English Pokémon set, card and sealed product (about 31,800 products in 221 sets) with TCGplayer market prices per printing, search, filters and set pages.
- Daily price history, 7- and 30-day price changes on every card page, and live Cardmarket (EU) trends from TCGdex.
- A market page (`/market`): four price indices (modern chase cards, vintage, booster boxes, Elite Trainer Boxes), the week's and month's biggest movers among actively traded items, set value trends, and what traders here want and list most.
- Wantlist price alerts: set a target price and get notified when the market reaches it, plus an alert whenever someone lists a card on your wantlist.

**Trading**
- Listings for raw cards (condition), graded slabs (grader, grade, cert number) and sealed product, with values suggested from market prices and up to six photos of the actual copy. Photos are re-encoded on upload, which strips hidden GPS location data.
- Offers with a live value balance and optional cash top-up; accept or decline; ship to the hub with tracking; per-item inspection results; the receiving trader decides when a condition differs; delivery confirmation; reviews.
- Card payments through Stripe Checkout (optional, see below), with automatic refunds if a paid trade is cancelled.
- Reputation from hub-verified activity only: verified trade count, the share of a trader's items that matched their listing, and ratings from completed trades.

**Accounts and communication**
- Sign up, log in, password reset by email, email confirmation, a notification bell for every trade step, and trade emails (with an opt-out).
- Account deletion that removes personal data while keeping trade records for the other trader.

**Operations**
- Hub console (`/admin`): receive packages, record inspection results, record or check payments, track cash top-ups, ship out or return, cancel with automatic refunds, see the email log.
- Daily price sync with no setup on a normal server; one-time history import from TCGCSV's archives.
- JSON API: `/api/v1/products`, `/api/v1/products/:id`, `/api/v1/sets`, `/api/v1/listings`, `/api/v1/market`, `/api/v1/status` (documented at `/developers`).
- Draft Terms of Service and Privacy Policy pages, a branded 404 page, `robots.txt` and a sitemap of every catalog page.

## Run it

To put the site online, see [Deploying](#deploying) (Vercel takes about ten minutes to set up). To run it on your own computer:

Requires Node.js 20.9 or newer.

```bash
npm install
```

```bash
npm run sync
```

```bash
npm run backfill
```

```bash
npm run seed
```

```bash
npm run dev
```

Open http://localhost:3000.

- `npm run sync` downloads the catalog and today's prices (about a minute the first time). A running server also syncs on its own.
- `npm run backfill` is optional: it imports the 30 days of price history before your oldest day, so charts, movers and indices work straight away instead of filling in over weeks. Use `-- --days 90` for more. See "Price history" below.
- `npm run seed` is optional. It adds five demo accounts with listings and trades at different stages and prints their logins. `npm run seed -- --clear` removes them. Never seed a production database.
- To make your own account hub staff, put its email in `ADMIN_EMAILS` before signing up, or run `npm run admins` after adding it.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` then `npm start` | Production build and server |
| `npm test` | 50 tests: fees, trade rules, the full trade engine, payments, email, alerts, photos, account deletion |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm run sync -- --force` | Sync even if the source hasn't changed |

## Configuration

Everything is optional for local development. Copy `.env.example` to `.env.local`; each setting is explained there.

| Feature | Settings | Without them |
| --- | --- | --- |
| Email (verification, password resets, trade updates, alerts) | `RESEND_API_KEY`, `EMAIL_FROM` | Emails are recorded in the hub's email log and printed to the server log, not sent. Email confirmation isn't required. |
| Card payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Hub staff record payments by hand in the console. |
| Scheduled sync | `CRON_SECRET` (and `AUTO_SYNC=0` on serverless hosts other than Vercel) | A long-running server syncs itself. On Vercel the cron job in `vercel.json` does it and needs `CRON_SECRET`. |
| Hosted database | `DATABASE_URL`, `DATABASE_AUTH_TOKEN` (Vercel's Turso integration sets `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, which work too) | A local SQLite file in `data/`. Required on Vercel. |
| Public address | `APP_URL` | On Vercel, the project's production domain. Elsewhere, links in emails and payment return links point at localhost. |
| Demo data on Vercel | `DEMO_DATA=1` | Each Vercel build removes the demo traders and trades if they exist. |

**Email** uses [Resend](https://resend.com). Verify your sending domain there and set `EMAIL_FROM` to an address on it. Once delivery works, new traders must confirm their email before sending or accepting offers (override with `REQUIRE_EMAIL_VERIFICATION`).

**Card payments** use [Stripe Checkout](https://docs.stripe.com/payments/checkout). Set `STRIPE_SECRET_KEY` (start with a test-mode key), then add a webhook endpoint for `https://your-site/api/webhooks/stripe` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`. The payment code is tested against a stand-in for Stripe; run a few test-mode payments and a cancellation refund before taking real money.

## Where the data comes from

| Source | Used for | How |
| --- | --- | --- |
| [TCGCSV](https://tcgcsv.com) | Catalog and US prices (TCGplayer data, including sealed), price history | Synced into the local database once a day. Past days imported once from daily archives. No key. |
| [TCGdex](https://tcgdex.dev) | Cardmarket trend, card facts | Fetched live per card page, cached for an hour. No key. |

TCGCSV asks integrators to sync at most daily, identify themselves with a User-Agent, never call it from user-facing code, and never download the same archive twice. The sync and backfill follow those rules; please keep it that way, and change the User-Agent (`Handoff/0.1.0`) to your own app name in `src/lib/catalog/tcgcsv.ts` and `scripts/backfill-history.ts`.

**Price history.** The daily sync stores a history point whenever a price changes. `npm run backfill` fills in earlier days from TCGCSV's archives (one ~4 MB file per day, available back to 2024-02-08). Each archive is kept in `data/archives/` and each imported day is recorded, so nothing is downloaded twice. Delete `data/archives/` only if you won't import those days again.

**Not included: graded-card prices.** eBay sold listings, Card Ladder, Collectr, PriceCharting and similar need an account, approval or a paid key. Graded listings use the owner's value and show the raw card's market price for reference. A new source would plug in next to `src/lib/catalog/tcgdex.ts`.

On Vercel, `vercel.json` schedules the sync every day at 21:15 UTC (TCGCSV publishes around 20:05 UTC; on the Hobby plan the call comes at some point within that hour). On other serverless hosts timers don't survive between requests: set `AUTO_SYNC=0`, set `CRON_SECRET`, and have a scheduler call the sync endpoint once a day:

```bash
curl -X POST https://your-site.example/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"
```

## Before you take real trades

Search the code for `PLACEHOLDER` to find each of these.

1. **Name, hub address and fees** in `src/config/site.ts`. The fee numbers are examples.
2. **Legal pages.** `/terms` and `/privacy` are drafts written to match what the code does, with bracketed gaps (company name, jurisdiction, refund rules, what happens to counterfeits, minimum age). Have a lawyer finish them.
3. **Policies in the copy** (`src/app/how-it-works/page.tsx`): what the hub checks, who pays return shipping, what happens to a failed item. Make them match what you'll actually do.
4. **Cash top-ups.** With Stripe enabled, the hub collects a top-up from one trader; staff pass it to the other trader by hand and mark it in the console. Holding and forwarding money between users can count as money transmission; ask your lawyer, and consider Stripe Connect for payouts.
5. **Email and payments** need the accounts and settings above, plus a real test run.
6. **Image and data terms.** Product images load from TCGplayer's CDN and prices are TCGplayer data via TCGCSV. Check both parties' terms for commercial use.
7. **Hosting plans.** Vercel's free Hobby plan is for personal, non-commercial use; a business needs Vercel Pro. Turso's free plan allows 500 million rows read and 10 million rows written a month and blocks the database if either is exceeded; a preview uses a small fraction, but watch the usage page in Turso's dashboard and move to a paid plan before launch.

## Deploying

### Vercel

The repository is set up for Vercel. `vercel.json` schedules the daily price update and runs `npm run vercel-build`, which brings the database up to date before building (`scripts/prepare-deploy.ts`).

1. Push the code to a GitHub repository (private is fine).
2. In Vercel, choose **Add New → Project** and import the repository. Keep the detected settings (Next.js).
3. Connect a database: in the project, open **Storage**, choose **Turso Cloud**, create a database and connect it to the project. Pick a US East location if you're asked, next to Vercel's default region (Washington, D.C.). This adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
4. Under **Settings → Environment Variables**, add:
   - `CRON_SECRET`: a long random string of letters and numbers. Vercel sends it with the daily update call.
   - `ADMIN_EMAILS`: your email address, so the account you sign up with runs the hub console. If you made the account first, the next deploy makes it hub staff.
   - `DEMO_DATA` = `1` (optional): sample traders, listings and trades for a preview. Delete the variable and redeploy to remove them. The demo hub staff account can't sign in on a hosted database; your `ADMIN_EMAILS` account is the hub.
5. Deploy. If the first deploy ran before the database was connected, it stops with a message saying so; connect it and choose **Redeploy**.

The first build takes several minutes: it loads the catalog and today's prices, then the last 30 days of price history from TCGCSV's daily archives. Later builds only check for new prices. If TCGCSV is unreachable during a build, the deploy still goes ahead and the daily update catches up.

On Vercel, listing photos are shrunk in the browser so a save with six photos stays under Vercel's 4.5 MB request limit, and the daily update runs only on production deployments, not previews.

### Other hosts

The app is a standard Next.js server.

- **A host with a persistent disk** (a VPS, Railway, Render, Fly): `npm run build`, `npm start`, keep the `data/` folder on the disk. Nothing else is needed.
- **Another serverless host**: point `DATABASE_URL` at a hosted libSQL database (for example Turso), add `DATABASE_AUTH_TOKEN`, schedule the sync as shown above, and set the email and Stripe variables. The same code runs against both. Listing photos are stored in the database, so they work there too; at larger scale, move them to object storage.

Set `APP_URL` to the public https address (on Vercel it defaults to the production domain). Login and reset rate limiting is kept in memory, which suits one server process; move it to a shared store if you run several.

## How the code is organized

```
src/config/site.ts          name, hub address, fees, legal placeholders
src/lib/db/                 database client, schema migrations
src/lib/catalog/            TCGCSV sync, TCGdex, catalog queries, market analytics, alerts, scheduler
src/lib/auth/               passwords, sessions, tokens, signup/login/reset/verify, account deletion
src/lib/listings/           listings, wantlist, reputation queries and actions
src/lib/photos/             photo processing (re-encode, strip metadata) and storage
src/lib/trades/machine.ts   trade lifecycle rules (pure, unit-tested)
src/lib/trades/service.ts   every state change of a trade: atomic, permission-checked, with notifications
src/lib/payments/           Stripe Checkout, webhooks, refunds
src/lib/email/              outbox, delivery through Resend, templates
src/lib/notifications.ts    the bell, and which events also send email
src/lib/fees.ts             fee and balance maths
src/app/                    pages and API routes
src/components/             shared UI
scripts/                    sync, backfill, seed, and the pre-build data step for Vercel
vercel.json                 Vercel build command and the daily update schedule
```

Two things worth knowing before changing pages:

- This is Next.js 16 with Cache Components. Catalog and market data are cached and refreshed after each sync; anything about listings, trades or the signed-in user is read live. Live reads go through `getCurrentUser()` or call `connection()` first, because a local SQLite read is fast enough that Next.js would otherwise treat it as cacheable. `AGENTS.md` points at the framework docs bundled in `node_modules/next/dist/docs/`.
- Don't read the JavaScript clock (`new Date()`, `Date.now()`) while rendering a page; use `SQL_NOW` in the query or format a stored timestamp.

A missing page reached through a link (a deleted listing, a trade that isn't yours) shows the 404 page with HTTP status 200 and a `noindex` tag; that's how this framework streams pages. Unknown URLs return a real 404.

If styles look stale during development, stop the dev server, delete `.next/`, and start it again.
