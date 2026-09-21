import { build as buildFrontend } from "vite";
import { build as buildBackend } from "esbuild";

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
