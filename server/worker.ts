import "dotenv/config";
import { invoiceCollectionSettings, invoicePaymentPromises } from "../drizzle/schema";
import { processDueInvoiceCollections } from "./services/invoiceCollections";
import { pathToFileURL } from "node:url";
import { requireDb, verifyDatabaseConnectivity } from "./db";
import { processDueAutomationBatch } from "./services/queue";
import { processDueInterviewReminders } from "./services/interviewReminders";

export async function runWorker(once = false) {
  if (!/^mysql:\/\//.test(process.env.DATABASE_URL ?? "")) throw new Error("The standalone worker requires a persistent MySQL DATABASE_URL.");
  const db = await requireDb();
  if (!db.$client) throw new Error("The standalone worker refuses an in-memory database adapter.");
  const connection = await verifyDatabaseConnectivity();
  if (!connection.connected) throw new Error("Worker database connection failed.");
  try {
    await db.select({ id: invoiceCollectionSettings.id }).from(invoiceCollectionSettings).limit(1);
    await db.select({ id: invoicePaymentPromises.id }).from(invoicePaymentPromises).limit(1);
  } catch { throw new Error("Collection schema is unavailable. Apply pnpm db:migrate to this database before starting the worker."); }
  let stopping = false, lastEnrollment = 0;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  do {
    if (Date.now() - lastEnrollment >= 60000) {
      const source = await processDueInterviewReminders(undefined, 25);
      console.info("Interview follow-up enrollment", source);
      console.info("Invoice collection evaluation", await processDueInvoiceCollections(undefined, 25));
      lastEnrollment = Date.now();
    }
    const result = await processDueAutomationBatch(undefined, 25);
    console.info("Automation batch", { processed: result.processed, skipped: result.skipped });
    if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, 5000));
  } while (!once && !stopping);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker(process.argv.includes("--once")).then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
}
