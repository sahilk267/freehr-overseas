import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const adminUrl = new URL(process.env.FREEHR_MYSQL_TEST_ADMIN_URL || 'mysql://root@127.0.0.1:3307/mysql');
if (adminUrl.protocol !== 'mysql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname)) throw new Error('Disposable SQL tests require a local MySQL admin endpoint. Never use production credentials.');
const database = `freehr_e2e_${Date.now()}_${randomBytes(4).toString('hex')}`;
const admin = await mysql.createConnection(adminUrl.toString());
let created = false;
try {
  await admin.query(`CREATE DATABASE \`${database}\``);
  created = true;
  const target = new URL(adminUrl); target.pathname = '/' + database;
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: target.toString(), FREEHR_TEST_MYSQL: '1' };
  const run = (args, timeout) => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout });
    if (result.error || result.status !== 0) throw new Error('Disposable SQL verification failed. Inspect the synthetic test output.');
  };
  run(['scripts/migrate-db.mjs'], 120000);
  run(['node_modules/vitest/vitest.mjs', 'run',
    'server/services/analytics.test.ts', 'server/services/interviewFeedback.test.ts', 'server/services/careerEvidence.test.ts', 'server/services/candidateOffers.test.ts', 'server/services/placementLifecycle.test.ts', 'server/services/stripePayments.test.ts', 'server/services/commercialAgreements.test.ts', 'server/services/candidateReviewOperations.test.ts', 'server/services/candidateReview.test.ts', 'server/services/weightedScorecard.test.ts', 'server/services/documentLifecycle.test.ts', 'server/services/globalRanking.test.ts', 'server/services/rankedMatching.test.ts', 'server/services/jobDocument.test.ts', 'server/services/jobExtraction.test.ts', 'server/services/jobIntake.test.ts', 'server/services/discoveryCalendar.test.ts', 'server/services/discoveryMail.test.ts', 'server/services/clientDiscovery.test.ts', 'server/services/replyMail.test.ts', 'server/services/replyTriage.test.ts', 'server/services/recoveryAutoSelection.test.ts', 'server/services/interviewRecoveryDeadline.test.ts', 'server/services/interviewRecovery.test.ts', 'server/services/confirmationMail.test.ts', 'server/services/interviewConfirmations.test.ts', 'server/services/availabilityMail.test.ts', 'server/services/collectedBooking.test.ts', 'server/services/participantAvailability.test.ts', 'server/services/interviewSlotHolds.test.ts', 'server/services/googleCalendar.test.ts',
    'server/services/interviewScheduling.test.ts', 'server/services/campaigns.test.ts',
    'server/services/sourceIntake.test.ts', 'server/services/backgroundWorker.test.ts',
    'server/e2eRegression.test.ts', 'server/w0Correctness.test.ts',
    'server/services/followups.test.ts', 'server/services/followupRecovery.test.ts',
    'server/services/invoiceCollections.test.ts', 'server/routers/email.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '--testTimeout=30000'], 180000);
} finally {
  if (created) await admin.query(`DROP DATABASE \`${database}\``);
  await admin.end();
}
