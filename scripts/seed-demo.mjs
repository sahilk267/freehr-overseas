import crypto from "node:crypto";
import mysql from "mysql2/promise";

const databaseUrl = process.env.DATABASE_URL;
const ownerOpenId = process.env.DEMO_OWNER_OPEN_ID;
if (!databaseUrl || !ownerOpenId) {
  throw new Error("Set DATABASE_URL and DEMO_OWNER_OPEN_ID before running the optional demo seed.");
}

const url = new URL(databaseUrl);
const sslParam = url.searchParams.get("ssl");
let ssl;
if (sslParam === "true" || sslParam === "1") {
  ssl = { rejectUnauthorized: true };
} else if (sslParam?.startsWith("{")) {
  ssl = JSON.parse(sslParam);
} else if (sslParam === null) {
  // TiDB Cloud and many Hostinger MySQL deployments require TLS.
  ssl = { rejectUnauthorized: true };
}
const connection = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), ssl });
const [[owner]] = await connection.query("SELECT id FROM users WHERE openId = ? LIMIT 1", [ownerOpenId]);
if (!owner) throw new Error("The specified demo owner has not signed in yet. Sign in once, then rerun the script.");

const suffix = crypto.randomBytes(4).toString("hex");
const companyId = `demo_cmp_${suffix}`;
const candidateId = `demo_can_${suffix}`;
const jobId = `demo_job_${suffix}`;
const ownerId = owner.id;
await connection.query("INSERT INTO companies (id, ownerId, name, companyType, pipelineState, sourceType, confidence, createdAt, updatedAt) VALUES (?, ?, ?, 'prospect', 'new', 'demo_script', 100, NOW(), NOW())", [companyId, ownerId, `Demo Systems — Fictional ${suffix}`]);
await connection.query("INSERT INTO candidates (id, ownerId, fullName, headline, sourceType, profileState, sourceCollectedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'demo_script', 'consent_pending', NOW(), NOW(), NOW())", [candidateId, ownerId, `Demo Candidate ${suffix}`, "Fictional profile for workflow validation only"]);
await connection.query("INSERT INTO jobs (id, ownerId, companyId, title, pipelineState, requirementQuality, mustHaveSkills, niceToHaveSkills, scorecard, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'draft', 100, JSON_ARRAY('TypeScript'), JSON_ARRAY(), JSON_ARRAY(JSON_OBJECT('criterion', 'Technical evidence', 'weight', 100, 'required', true)), NOW(), NOW())", [jobId, ownerId, companyId, `Demo Backend Engineer — Test Only ${suffix}`]);
console.log(JSON.stringify({ seeded: true, companyId, candidateId, jobId, note: "Fictional demo records only. Remove them after workflow validation." }));
await connection.end();
