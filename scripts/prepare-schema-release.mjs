import { readFile, writeFile } from "node:fs/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const previous = JSON.parse(await readFile(new URL("deploy/schema-release.json", root), "utf8"));
const journal = JSON.parse(await readFile(new URL("drizzle/meta/_journal.json", root), "utf8"));
const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("drizzle", root)) });
const baseline = journal.entries.findIndex(entry => entry.tag === previous.baseline);
if (baseline < 0 || baseline >= journal.entries.length - 1) throw Error("Choose an existing reviewed baseline before preparing a release.");
const release = { version: 1, targetDomain: previous.targetDomain, baseline: previous.baseline, through: journal.entries.at(-1).tag, migrations: journal.entries.slice(baseline + 1).map((entry, index) => ({ tag: entry.tag, sha256: migrations[baseline + 1 + index].hash })) };
await writeFile(new URL("deploy/schema-release.json", root), JSON.stringify(release, null, 2) + "\n");
console.log("Prepared schema release hashes. Review every migration before committing this manifest.");
