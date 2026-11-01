import { build as buildFrontend } from "vite";
import { build as buildBackend } from "esbuild";
import { execFileSync } from "node:child_process";

let buildCommit = "unknown";
try {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (/^[a-f0-9]{40}$/.test(head)) buildCommit = head;
} catch { /* Source archives may omit Git metadata; never invent a commit. */ }

// The standalone production server authenticates through OIDC.
process.env.VITE_AUTH_MODE ||= process.env.AUTH_MODE === "owner_password" ? "owner_password" : "oidc";
await buildFrontend();

await buildBackend({
  entryPoints: ["server/hostinger.ts"],
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  sourcemap: true,
  outfile: "dist/hostinger.js",
  define: { "process.env.FREEHR_BUILD_COMMIT": JSON.stringify(buildCommit) },
});

await buildBackend({ entryPoints: ["server/worker.ts"], platform: "node", packages: "external", bundle: true, format: "esm", sourcemap: true, outfile: "dist/worker.js" });
