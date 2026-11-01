// Stable entry for Hostinger's default `node server.js` launch command.
process.env.NODE_ENV ||= "production";

// LiteSpeed loads this file through require(). Keep its ESM graph synchronous;
// the compiled application can still initialize asynchronously after loading.
import("./dist/hostinger.js")
  .then(async ({ startHostingerServer }) => {
    // Only this target's reviewed existing baseline is upgraded automatically.
    // Other targets retain explicit opt-in; an explicit false always wins.
    if (process.env.RUN_DB_MIGRATIONS === "true") {
      const { migrateDatabase } = await import("./scripts/migrate-db.mjs");
      await migrateDatabase();
    } else if (process.env.RUN_DB_MIGRATIONS !== "false" && process.env.APP_BASE_URL) {
      const { readFile } = await import("node:fs/promises");
      const release = JSON.parse(await readFile(new URL("./deploy/schema-release.json", import.meta.url), "utf8"));
      const { migrateReviewedReleaseForTarget } = await import("./scripts/migrate-db.mjs");
      await migrateReviewedReleaseForTarget({ release, appBaseUrl: process.env.APP_BASE_URL });
    }
    return startHostingerServer();
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
