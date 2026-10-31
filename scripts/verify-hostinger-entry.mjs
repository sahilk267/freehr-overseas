import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sandbox = await mkdtemp(path.join(os.tmpdir(), "freehr-entry-"));
function launch(entry, extraEnv = {}) {
  const child = spawn(process.execPath, Array.isArray(entry) ? entry : [entry], { cwd: sandbox, env: { PATH: process.env.PATH, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exited = once(child, "exit");
  return { child, exited, output: () => output };
}
async function stop(run) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill("SIGTERM");
  const timer = setTimeout(() => run.child.kill("SIGKILL"), 5000);
  try { await run.exited; } finally { clearTimeout(timer); }
}
async function verifyListening(entry) {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const run = launch(entry, { NODE_ENV: "test", PORT: String(port) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (run.child.exitCode !== null) throw new Error(run.output());
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === "ok") { ready = true; break; }
      } catch {}
      await delay(100);
    }
    assert.ok(ready, `Entry did not bind PORT: ${run.output()}`);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    const protectedRoute = await fetch(`http://127.0.0.1:${port}/api/trpc/operations.dashboard`);
    assert.equal(protectedRoute.status, 401);
  } finally { await stop(run); }
}
try {
  // No .env, inherited app secrets or database configuration enter this sandbox.
  await copyFile(path.join(root, "server.js"), path.join(sandbox, "server.mjs"));
  await symlink(path.join(root, "dist"), path.join(sandbox, "dist"), "dir");
  const unconfigured = launch(path.join(sandbox, "server.mjs"));
  try {
    const result = await Promise.race([unconfigured.exited, delay(15000, null, { ref: false })]);
    assert.ok(result, "Unconfigured entry did not stop");
    assert.notEqual(result[0], 0);
    assert.match(unconfigured.output(), /DATABASE_URL/);
    console.log("PASS: default entry refuses missing production database configuration.");
  } finally { await stop(unconfigured); }
  await verifyListening(path.join(sandbox, "server.mjs"));
  console.log("PASS: Hostinger root entry binds PORT, serves the built UI and protects the dashboard.");
  await verifyListening(["--input-type=commonjs", "--eval", `require(${JSON.stringify(path.join(root, "server.js"))})`]);
  console.log("PASS: LiteSpeed-style CommonJS require loads the root entry and starts the protected server.");
  await verifyListening(path.join(root, "dist/hostinger.js"));
  console.log("PASS: direct dist/hostinger.js entry remains supported.");
} finally { await rm(sandbox, { recursive: true, force: true }); }
