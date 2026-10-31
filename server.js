// Stable entry for Hostinger's default `node server.js` launch command.
process.env.NODE_ENV ||= "production";

// LiteSpeed loads this file through require(). Keep its ESM graph synchronous;
// the compiled application can still initialize asynchronously after loading.
import("./dist/hostinger.js")
  .then(async ({ startHostingerServer }) => {
    // Opt in only after selecting the deployment's database. Run on the host,
    // where localhost reaches MySQL, rather than inside its isolated builder.
    if (process.env.RUN_DB_MIGRATIONS === "true") {
      await import("./scripts/migrate-db.mjs");
    }
    return startHostingerServer();
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
