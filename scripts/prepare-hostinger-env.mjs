import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let output = path.join(root, ".env.hostinger"), source;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (!["--output", "--from"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Use --output PRIVATE_ENV_PATH and optional --from PRIVATE_SOURCE_PATH.");
  const value = path.resolve(args[++index]);
  if (flag === "--output") output = value; else source = value;
}

function isPlaceholder(value) {
  return !value?.trim() || /^(?:your[-_ ]|replace[-_ ]|<[^>]+>$)/i.test(value) || /\/home\/username(?:\/|$)/i.test(value) || /^mysql:\/\/freelancehr_user:db_password@/i.test(value);
}
function serialize(key, value) {
  if (/[\r\n\0]/.test(value)) throw new Error(`${key} must contain a single-line value.`);
  for (const candidate of [JSON.stringify(value), `'${value}'`, `\`${value}\``, value]) {
    if (parse(`${key}=${candidate}`)[key] === value) return candidate;
  }
  throw new Error(`${key} cannot be represented safely in this dotenv file; configure it directly in hPanel.`);
}
async function optionalRead(file) {
  try { return await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
async function prepare() {
  if (!/^\.env(?:\.|$)/.test(path.basename(output)) || /example/i.test(path.basename(output))) throw new Error("Output must be a private .env file, never a template or public deployment file.");
  const relative = path.relative(root, output);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    try { execFileSync("git", ["check-ignore", "--quiet", "--", relative], { cwd: root, stdio: "ignore" }); }
    catch { throw new Error("Output inside the repository must be ignored by Git and untracked."); }
  }
  try { if ((await lstat(output)).isSymbolicLink()) throw new Error("Refusing a symbolic-link output."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const lock = `${output}.lock`;
  let lockHandle;
  try { lockHandle = await open(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Environment preparation is already locked; do not run concurrent generators."); throw error; }
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    const template = await readFile(path.join(root, "deploy/hostinger.env.example"), "utf8");
    const values = parse(template), keys = Object.keys(values);
    const existing = parse(await optionalRead(output));
    const supplied = source ? parse(await readFile(source, "utf8")) : {};
    for (const key of keys) {
      for (const data of [existing, supplied]) if (Object.hasOwn(data, key) && !isPlaceholder(data[key])) values[key] = data[key];
      if (isPlaceholder(values[key])) values[key] = "";
    }
    // This helper prepares the initial private production pilot, not preview auth.
    Object.assign(values, { NODE_ENV: "production", AUTH_MODE: "oidc", VITE_AUTH_MODE: "oidc", OWNER_ONLY_MODE: "true" });
    const generated = [];
    for (const key of ["SESSION_SECRET", "CRON_SECRET", "HOSTINGER_MAIL_WEBHOOK_SECRET"]) {
      if (!values[key]) { values[key] = randomBytes(32).toString("hex"); generated.push(key); }
    }
    for (const key of ["SESSION_SECRET", "CRON_SECRET", "HOSTINGER_MAIL_WEBHOOK_SECRET"]) {
      const minimum = key === "SESSION_SECRET" ? 32 : 8;
      if (values[key].length < minimum) throw new Error(`${key} is too short; existing secrets are not rotated automatically.`);
    }
    for (const key of ["APP_BASE_URL", "OIDC_ISSUER_URL", "OIDC_REDIRECT_URI"]) {
      if (!values[key]) continue;
      try { if (new URL(values[key]).protocol !== "https:") throw new Error(); }
      catch { throw new Error(`${key} must be a valid HTTPS URL.`); }
    }
    if (values.DATABASE_URL) {
      try { if (!["mysql:", "mysql2:", "mariadb:"].includes(new URL(values.DATABASE_URL).protocol)) throw new Error(); }
      catch { throw new Error("DATABASE_URL must be a valid MySQL connection URL."); }
    }
    if (values.PRIVATE_STORAGE_MODE === "local" && values.PRIVATE_LOCAL_STORAGE_PATH && !path.isAbsolute(values.PRIVATE_LOCAL_STORAGE_PATH)) throw new Error("PRIVATE_LOCAL_STORAGE_PATH must be an absolute path.");
    const rendered = template.replace(/^([A-Z][A-Z0-9_]*)=.*$/gm, (_, key) => `${key}=${serialize(key, values[key])}`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(rendered); } finally { await handle.close(); }
    await rename(temporary, output);
    const required = ["DATABASE_URL", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "APP_BASE_URL"];
    if (!values.PRIMARY_OWNER_EMAIL && !values.PRIMARY_OWNER_OPEN_ID) required.push("PRIMARY_OWNER_EMAIL");
    if (values.PRIVATE_STORAGE_MODE === "local") required.push("PRIVATE_LOCAL_STORAGE_PATH");
    if (values.PRIVATE_STORAGE_MODE === "s3") required.push("STORAGE_BUCKET", "STORAGE_REGION", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY");
    console.log(JSON.stringify({ output, variables: keys.length, generated_keys: generated, pending_setup_keys: required.filter(key => !values[key]), file_mode: "0600", all_required_values_present: required.every(key => Boolean(values[key])) }, null, 2));
  } finally {
    await rm(temporary, { force: true });
    await lockHandle.close();
    await rm(lock, { force: true });
  }
}

try { await prepare(); } catch (error) { console.error(error.message); process.exitCode = 1; }
