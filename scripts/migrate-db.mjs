import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const folder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function validateReviewedUpgrade(journal, migrations, applied, release) {
  if (release.version !== 1 || !Array.isArray(release.migrations)) throw Error("Invalid reviewed schema release.");
  const baseline = journal.entries.findIndex(e => e.tag === release.baseline);
  const through = journal.entries.findIndex(e => e.tag === release.through);
  if (baseline < 0 || through !== journal.entries.length - 1 || through <= baseline) throw Error("Schema journal exceeds the reviewed release boundary.");
  if (applied.length < baseline + 1 || applied.length > migrations.length) throw Error("Database is outside this release's reviewed baseline. Use an explicitly reviewed migration command.");
  const appliedOrdered = [...applied].sort((a, b) => Number(a.created_at) - Number(b.created_at));
  for (let i = 0; i < appliedOrdered.length; i++) {
    if (appliedOrdered[i].hash !== migrations[i].hash || Number(appliedOrdered[i].created_at) !== migrations[i].folderMillis) throw Error("Applied migration history differs from the canonical journal.");
  }
  const expected = journal.entries.slice(baseline + 1, through + 1).map((entry, i) => ({ tag: entry.tag, sha256: migrations[baseline + 1 + i].hash }));
  if (JSON.stringify(release.migrations) !== JSON.stringify(expected)) throw Error("Reviewed migration content changed; regenerate and review the release manifest.");
  return migrations.length - applied.length;
}

export async function migrateDatabase({ reviewedRelease } = {}) {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required to apply database migrations.");
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  let lockName;
  try {
    const [[database]] = await connection.query("SELECT DATABASE() AS name");
    lockName = `freehr_migrate_${createHash("sha256").update(database.name).digest("hex").slice(0, 40)}`;
    const [[lock]] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
    if (Number(lock.acquired) !== 1) throw Error("Another migration process owns the database upgrade lock.");
    if (reviewedRelease) {
      const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
      const migrations = readMigrationFiles({ migrationsFolder: folder });
      const [applied] = await connection.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at");
      validateReviewedUpgrade(journal, migrations, applied, reviewedRelease);
    }
    await migrate(drizzle(connection), { migrationsFolder: folder });
    console.log("Database migrations completed.");
  } finally {
    if (lockName) await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    await connection.end();
  }
}

export async function migrateReviewedReleaseForTarget({ release, appBaseUrl, setting }) {
  if (setting === "false") return { applied: false, reason: "explicitly_disabled" };
  if (setting === "true") { await migrateDatabase(); return { applied: true, mode: "explicit" }; }
  let hostname;
  try { hostname = new URL(appBaseUrl).hostname; } catch { return { applied: false, reason: "no_target" }; }
  if (hostname !== release.targetDomain) return { applied: false, reason: "different_target" };
  await migrateDatabase({ reviewedRelease: release });
  return { applied: true, mode: "reviewed_release" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrateDatabase();
}
