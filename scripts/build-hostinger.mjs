import { build as buildFrontend } from "vite";
import { build as buildBackend } from "esbuild";

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
});

await buildBackend({ entryPoints: ["server/worker.ts"], platform: "node", packages: "external", bundle: true, format: "esm", sourcemap: true, outfile: "dist/worker.js" });
