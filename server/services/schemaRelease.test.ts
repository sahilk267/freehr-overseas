import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { validateReviewedUpgrade, migrateReviewedReleaseForTarget } from "../../scripts/migrate-db.mjs";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
const release = JSON.parse(readFileSync("deploy/schema-release.json", "utf8"));
const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
const applied = migrations.map(m => ({ hash: m.hash, created_at: m.folderMillis }));

describe("reviewed schema deployment boundary", () => {
  it("accepts the exact existing baseline, incremental upgrades and a repeated no-op", () => {
    expect(validateReviewedUpgrade(journal, migrations, applied.slice(0, 15), release)).toBe(7);
    expect(validateReviewedUpgrade(journal, migrations, applied.slice(0, 17), release)).toBe(5);
    expect(validateReviewedUpgrade(journal, migrations, applied, release)).toBe(0);
  });
  it("rejects empty, older, divergent and unreviewed migration histories", () => {
    for (const history of [[], applied.slice(0, 14), [{ ...applied[0], hash: "different" }, ...applied.slice(1)]]) expect(() => validateReviewedUpgrade(journal, migrations, history, release)).toThrow();
    expect(() => validateReviewedUpgrade(journal, migrations, applied, { ...release, migrations: release.migrations.map((m, i) => i ? m : { ...m, sha256: "changed" }) })).toThrow(/content changed/);
    expect(() => validateReviewedUpgrade({ entries: [...journal.entries, { tag: "future-unreviewed" }] }, migrations, applied, release)).toThrow(/boundary/);
  });
  it("respects an explicit opt-out and does not apply this site's release to other targets", async () => {
    expect(await migrateReviewedReleaseForTarget({ release, appBaseUrl: "https://freelancehr.overseasjob.in", setting: "false" })).toMatchObject({ applied: false, reason: "explicitly_disabled" });
    expect(await migrateReviewedReleaseForTarget({ release, appBaseUrl: "https://other.example.test" })).toMatchObject({ applied: false, reason: "different_target" });
    expect(await migrateReviewedReleaseForTarget({ release })).toMatchObject({ applied: false, reason: "no_target" });
  });
});
