/**
 * Makes existing accounts whose email is listed in ADMIN_EMAILS hub staff.
 *
 *   npm run admins
 *
 * A sign-up with one of those emails becomes hub staff by itself. This covers
 * an account created before its email was added to ADMIN_EMAILS. Vercel builds
 * run it automatically (scripts/prepare-deploy.ts). Demo and deleted accounts
 * are never promoted.
 */
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadEnvFile(file);
}

async function main() {
  const emails = [
    ...new Set(
      (process.env.ADMIN_EMAILS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (emails.length === 0) {
    console.log("ADMIN_EMAILS is empty; no accounts to update.");
    return;
  }

  // Imported after env is loaded so DATABASE_URL is honoured.
  const { run } = await import("../src/lib/db/client");
  const promoted = await run(
    `UPDATE users SET role = 'admin'
      WHERE lower(email) IN (${emails.map(() => "?").join(", ")})
        AND role <> 'admin' AND deleted_at IS NULL AND is_demo = 0`,
    emails,
  );
  console.log(
    promoted > 0
      ? `${promoted} existing account${promoted === 1 ? "" : "s"} made hub staff.`
      : "No existing accounts needed updating. Signing up with an ADMIN_EMAILS address makes the account hub staff.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
