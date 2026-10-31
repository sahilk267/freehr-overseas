import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "dotenv";

const root = fileURLToPath(new URL("../", import.meta.url));
const generatedKeys = ["SESSION_SECRET", "CRON_SECRET", "HOSTINGER_MAIL_WEBHOOK_SECRET"];
const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/prepare-hostinger-env.mjs"), ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
async function fixture(work) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "freehr-env-test-"));
  try { await work(folder, path.join(folder, ".env.hostinger")); } finally { await rm(folder, { recursive: true, force: true }); }
}

test("imports production defaults and creates three private independent secrets without logging their values", () => fixture(async (folder, output) => {
  const result = run("--output", output, "--from", path.join(root, ".env.example"));
  assert.equal(result.status, 0, result.stderr);
  const env = parse(await readFile(output)), source = parse(await readFile(path.join(root, ".env.example")));
  assert.equal(env.PRIMARY_OWNER_EMAIL, source.PRIMARY_OWNER_EMAIL);
  assert.equal(env.OIDC_ISSUER_URL, source.OIDC_ISSUER_URL);
  assert.equal(env.NODE_ENV, "production"); assert.equal(env.OWNER_ONLY_MODE, "true");
  assert.equal(env.VITE_AUTH_MODE, "oidc"); assert.equal(env.AUTH_MODE, "oidc");
  assert.equal(env.DATABASE_URL, ""); assert.equal(env.OIDC_CLIENT_SECRET, ""); assert.equal(env.PRIVATE_LOCAL_STORAGE_PATH, "");
  assert.ok(!Object.hasOwn(env, "PORT")); assert.ok(!Object.hasOwn(env, "JWT_SECRET"));
  assert.ok(!Object.hasOwn(env, "BUILT_IN_FORGE_API_KEY"));
  for (const purpose of ["OWNER", "CLIENTS", "TALENT", "INTERVIEWS", "FINANCE", "PRIVACY"]) {
    assert.equal(env[`${purpose}_MAILBOX`], source[`${purpose}_MAILBOX`]);
    assert.equal(env[`HOSTINGER_MAILBOX_${purpose}_ADDRESS`], source[`${purpose}_MAILBOX`]);
    assert.equal(env[`HOSTINGER_MAILBOX_${purpose}_ID`], "");
  }
  assert.equal(new Set(generatedKeys.map(key => env[key])).size, 3);
  for (const key of generatedKeys) { assert.match(env[key], /^[a-f0-9]{64}$/); assert.ok(!result.stdout.includes(env[key])); }
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(result.stdout).pending_setup_keys.sort(), ["DATABASE_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "PRIVATE_LOCAL_STORAGE_PATH"].sort());
}));

test("re-running preserves secrets and provider values, including characters needing dotenv quoting", () => fixture(async (folder, output) => {
  assert.equal(run("--output", output).status, 0);
  const before = parse(await readFile(output));
  const input = path.join(folder, ".env.provider");
  const secret = 'synthetic#provider\'"\\value';
  await writeFile(input, `OIDC_CLIENT_SECRET=\`${secret}\`\nOIDC_CLIENT_ID=synthetic-client\nDATABASE_URL=mysql://synthetic:synthetic%23password@db.example.test:3306/freehr\nPRIVATE_LOCAL_STORAGE_PATH=${folder}/private\n`);
  const second = run("--output", output, "--from", input);
  assert.equal(second.status, 0, second.stderr);
  let after = parse(await readFile(output)); assert.equal(after.OIDC_CLIENT_SECRET, secret);
  for (const key of generatedKeys) assert.equal(after[key], before[key]);
  assert.equal(JSON.parse(second.stdout).all_required_values_present, true);
  assert.ok(!second.stdout.includes(secret));
  await writeFile(input, "OIDC_CLIENT_SECRET=\nSESSION_SECRET=your-example-placeholder\n");
  assert.equal(run("--output", output, "--from", input).status, 0);
  after = parse(await readFile(output)); assert.equal(after.OIDC_CLIENT_SECRET, secret);
  for (const key of generatedKeys) assert.equal(after[key], before[key]);
  assert.deepEqual(JSON.parse(run("--output", output).stdout).generated_keys, []);
}));

test("refuses public/template outputs and leaves the committed template unchanged", async () => {
  const template = path.join(root, "deploy/hostinger.env.example"), before = await readFile(template);
  const result = run("--output", template);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /private \.env/);
  assert.deepEqual(await readFile(template), before);
});

test("refuses symbolic-link outputs instead of writing secrets through them", () => fixture(async (folder, output) => {
  const target = path.join(folder, "public.txt"); await writeFile(target, "unchanged"); await symlink(target, output);
  const result = run("--output", output);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /symbolic-link/);
  assert.equal(await readFile(target, "utf8"), "unchanged");
}));

test("rejects multiline values without changing an existing file or leaking the value", () => fixture(async (folder, output) => {
  assert.equal(run("--output", output).status, 0); const before = await readFile(output);
  const input = path.join(folder, ".env.provider"); await writeFile(input, 'OIDC_CLIENT_SECRET="synthetic-sensitive\\nNODE_ENV=development"\n');
  const result = run("--output", output, "--from", input);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /OIDC_CLIENT_SECRET must contain a single-line value/);
  assert.ok(!result.stderr.includes("synthetic-sensitive")); assert.deepEqual(await readFile(output), before);
}));

test("rejects invalid connection URLs without exposing them or rotating existing secrets", () => fixture(async (folder, output) => {
  assert.equal(run("--output", output).status, 0); const before = await readFile(output);
  const input = path.join(folder, ".env.provider"); await writeFile(input, "DATABASE_URL=https://synthetic-sensitive.example.test\n");
  const result = run("--output", output, "--from", input);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /DATABASE_URL must be a valid MySQL/);
  assert.ok(!result.stderr.includes("synthetic-sensitive")); assert.deepEqual(await readFile(output), before);
}));

test("preserves personal owner mode and requires its password hash instead of Google credentials", () => fixture(async (folder, output) => {
  const source = path.join(folder, ".env.owner");
  const hash = `scrypt:${"ab".repeat(16)}:${"cd".repeat(64)}`;
  await writeFile(source, `AUTH_MODE=owner_password\nPRIMARY_OWNER_OPEN_ID=personal_owner\nOWNER_PASSWORD_HASH=${hash}\nDATABASE_URL=mysql://synthetic:synthetic@127.0.0.1:3306/freelancehr\nPRIVATE_LOCAL_STORAGE_PATH=/private/freelancehr\n`);
  let result = run("--output", output, "--from", source);
  assert.equal(result.status, 0, result.stderr);
  const env = parse(await readFile(output));
  assert.equal(env.AUTH_MODE, "owner_password"); assert.equal(env.VITE_AUTH_MODE, "owner_password");
  assert.equal(env.OWNER_PASSWORD_HASH, hash);
  assert.equal(JSON.parse(result.stdout).all_required_values_present, true);
  result = run("--output", output);
  assert.equal(parse(await readFile(output)).AUTH_MODE, "owner_password");
  assert.ok(!result.stdout.includes(hash));
}));
